/* global Zotero, Services */
"use strict";

// AI summary of the open paper using a local Ollama server.
// Loaded into the bootstrap scope; only `var` declarations are used to avoid
// lexical-scope clashes with bootstrap.js.

var Summary = {
	PREF_HOST: "extensions.plugins4zotero.hebrewtranslate.ollamaHost",
	PREF_MODEL: "extensions.plugins4zotero.hebrewtranslate.ollamaModel",
	PREF_MAX_CHARS: "extensions.plugins4zotero.hebrewtranslate.summaryMaxChars",
	PREF_AUTOSTART: "extensions.plugins4zotero.hebrewtranslate.ollamaAutoStart",
	PREF_IGPU: "extensions.plugins4zotero.hebrewtranslate.ollamaIntegratedGPU",
	PREF_EXE: "extensions.plugins4zotero.hebrewtranslate.ollamaPath",
	DEFAULT_HOST: "http://localhost:11434",
	SUGGESTED_MODEL: "llama3.2",
	running: new Set(),
	server: null, // the `ollama serve` process we started, if any
	serverLog: "",

	getPref(name, fallback) {
		const v = Zotero.Prefs.get(name, true);
		return v === undefined || v === "" ? fallback : v;
	},

	// ---- UI ---------------------------------------------------------------

	onViewContextMenu(event) {
		const { reader, append } = event;
		append({
			label: "AI summary of this paper (Ollama)",
			onCommand: () => {
				Summary.run(reader.itemID).catch((e) => {
					Zotero.logError(e);
					Summary.alert("AI summary failed", String(e && e.message || e));
				});
			},
		});
	},

	alert(title, text) {
		Services.prompt.alert(Zotero.getMainWindow(), title, text);
	},

	progress(headline, text, closeAfterMs) {
		const pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline(headline);
		pw.addDescription(text);
		pw.show();
		if (closeAfterMs) pw.startCloseTimer(closeAfterMs);
		return pw;
	},

	// ---- Ollama -----------------------------------------------------------

	async ollama(path, body, timeout) {
		const host = String(Summary.getPref(Summary.PREF_HOST, Summary.DEFAULT_HOST)).replace(/\/+$/, "");
		const opts = { responseType: "json", timeout: timeout || 10000 };
		if (body) {
			opts.body = JSON.stringify(body);
			opts.headers = { "Content-Type": "application/json" };
		}
		const req = await Zotero.HTTP.request(body ? "POST" : "GET", host + path, opts);
		return req.response;
	},

	// Ollama explains failures in the response body ({"error": "..."}).
	errorText(e) {
		const r = e && e.xmlhttp && (e.xmlhttp.response || e.xmlhttp.responseText);
		let msg = r && (r.error || (typeof r === "string" && r)) || "";
		if (typeof msg !== "string") msg = JSON.stringify(msg);
		return msg || String(e && e.message || e);
	},

	// Returns the installed model names, or null if Ollama can't be reached.
	async listModels() {
		try {
			const r = await Summary.ollama("/api/tags");
			return (r.models || []).map(m => m.name);
		}
		catch (e) {
			Zotero.debug("[zoterohelper] Ollama not reachable: " + e);
			return null;
		}
	},

	// Drops models that can't generate text (e.g. embedding models). Older Ollama
	// versions don't report capabilities; those models are kept.
	async generativeModels(names) {
		const keep = [];
		for (const name of names) {
			try {
				const info = await Summary.ollama("/api/show", { model: name });
				if (Array.isArray(info.capabilities) && !info.capabilities.includes("completion")) continue;
			}
			catch (e) { /* keep it */ }
			keep.push(name);
		}
		return keep;
	},

	pickModel(installed) {
		const wanted = Summary.getPref(Summary.PREF_MODEL, "");
		if (wanted) {
			const match = installed.find(n => n === wanted || n.split(":")[0] === wanted);
			return { model: match || null, wanted };
		}
		const chat = installed.filter(n => !/embed/i.test(n));
		return { model: chat[0] || null, wanted: Summary.SUGGESTED_MODEL };
	},

	// Ollama uses the GPU automatically when it can. If that attempt fails
	// (e.g. out of VRAM / driver problem), retry on CPU only (num_gpu = 0).
	async generate(model, prompt) {
		const payload = (extra) => ({
			model,
			prompt,
			stream: false,
			options: Object.assign({ num_ctx: 8192, temperature: 0.2 }, extra),
		});
		const TEN_MIN = 10 * 60 * 1000;
		try {
			const r = await Summary.ollama("/api/generate", payload({}), TEN_MIN);
			return { text: r.response, device: await Summary.deviceUsed(model) };
		}
		catch (e) {
			if (e && e.status === 0) throw e; // server vanished: not a GPU problem
			if (e && e.status >= 400 && e.status < 500) {
				// Bad request / unknown or non-generative model: CPU won't help.
				throw new Error("Ollama rejected the request (HTTP " + e.status + ") for model \"" + model
					+ "\": " + Summary.errorText(e));
			}
			Zotero.debug("[zoterohelper] GPU run failed, retrying on CPU: " + e);
			try {
				const r = await Summary.ollama("/api/generate", payload({ num_gpu: 0 }), TEN_MIN);
				return { text: r.response, device: "CPU (GPU attempt failed)" };
			}
			catch (e2) {
				throw new Error("Ollama failed on GPU and CPU for model \"" + model + "\": " + Summary.errorText(e2));
			}
		}
	},

	async deviceUsed(model) {
		try {
			const r = await Summary.ollama("/api/ps");
			const m = (r.models || []).find(x => x.name === model || x.model === model);
			if (!m) return "unknown device";
			if (!m.size_vram) return "CPU";
			return m.size_vram >= m.size ? "GPU" : "GPU + CPU (partial offload)";
		}
		catch (e) {
			return "unknown device";
		}
	},


	// ---- starting `ollama serve` ourselves --------------------------------

	isLocalHost(url) {
		try {
			return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
		}
		catch (e) {
			return false;
		}
	},

	async findOllamaExe() {
		const custom = Summary.getPref(Summary.PREF_EXE, "");
		if (custom) return custom;
		const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
		for (const name of ["ollama.exe", "ollama"]) {
			try {
				return await Subprocess.pathSearch(name);
			}
			catch (e) { /* not on PATH */ }
		}
		const local = Services.env.get("LOCALAPPDATA");
		const candidates = [
			local && local + "\\Programs\\Ollama\\ollama.exe",
			"/usr/local/bin/ollama",
			"/opt/homebrew/bin/ollama",
			"/usr/bin/ollama",
			"/Applications/Ollama.app/Contents/Resources/ollama",
		].filter(Boolean);
		for (const c of candidates) {
			if (await IOUtils.exists(c)) return c;
		}
		return null;
	},

	// Starts `ollama serve` on the configured local host/port and waits for it.
	// Returns true once the server answers. The process is stopped by stopServer().
	async startServer() {
		const host = String(Summary.getPref(Summary.PREF_HOST, Summary.DEFAULT_HOST));
		if (!Summary.isLocalHost(host)) return false;
		const exe = await Summary.findOllamaExe();
		if (!exe) return false;

		const url = new URL(host);
		const env = { OLLAMA_HOST: url.hostname.replace(/[\[\]]/g, "") + ":" + (url.port || "11434") };
		if (Summary.getPref(Summary.PREF_IGPU, false)) {
			env.OLLAMA_VULKAN = "1";
			env.OLLAMA_IGPU_ENABLE = "1";
		}
		const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
		Summary.serverLog = "";
		const proc = await Subprocess.call({
			command: exe,
			arguments: ["serve"],
			environment: env,
			environmentAppend: true,
			stderr: "stdout",
		});
		Summary.server = proc;
		// The pipe must be drained or the server blocks once it fills up.
		(async () => {
			try {
				let chunk;
				while ((chunk = await proc.stdout.readString())) {
					Summary.serverLog = (Summary.serverLog + chunk).slice(-3000);
				}
			}
			catch (e) { /* process ended */ }
		})();

		for (let i = 0; i < 40; i++) { // up to ~20 s
			if (await Summary.listModels() !== null) return true;
			await Zotero.Promise.delay(500);
		}
		return false;
	},

	async stopServer() {
		const proc = Summary.server;
		Summary.server = null;
		if (!proc) return;
		try {
			await proc.kill();
		}
		catch (e) { /* already gone */ }
	},

	// ---- main flow --------------------------------------------------------

	async run(attachmentID) {
		if (Summary.running.has(attachmentID)) return;
		const attachment = Zotero.Items.get(attachmentID);
		if (!attachment) return;

		let models = await Summary.listModels();
		if (models === null && Summary.getPref(Summary.PREF_AUTOSTART, true)) {
			const pw0 = Summary.progress("AI summary", "Starting Ollama…");
			try {
				if (await Summary.startServer()) models = await Summary.listModels();
			}
			catch (e) {
				Zotero.logError(e);
			}
			finally {
				pw0.close();
			}
		}
		if (models !== null) models = await Summary.generativeModels(models);
		if (models === null) {
			Summary.alert(
				"Ollama is not available",
				"Could not reach Ollama at " + Summary.getPref(Summary.PREF_HOST, Summary.DEFAULT_HOST)
				+ ".\n\nInstall it from https://ollama.com, start it, and pull a model "
				+ "(for example: ollama pull " + Summary.SUGGESTED_MODEL + "), then try again."
				+ (Summary.serverLog ? "\n\nI tried to start it automatically; its output ended with:\n"
					+ Summary.serverLog.slice(-600) : "")
			);
			return;
		}
		const { model, wanted } = Summary.pickModel(models);
		if (!model) {
			Summary.alert(
				"No Ollama model available",
				"Model \"" + wanted + "\" is not installed.\n\nRun:  ollama pull " + wanted
				+ "\n\nor set the pref " + Summary.PREF_MODEL + " to a model you already have."
			);
			return;
		}

		Summary.running.add(attachmentID);
		let pw = Summary.progress("AI summary", "Reading the paper…");
		try {
			const fullText = await Zotero.PDFWorker.getFullText(attachmentID);
			let text = (fullText && fullText.text || "").trim();
			if (!text) throw new Error("No text could be extracted from this PDF (is it a scanned image?).");
			const maxChars = Number(Summary.getPref(Summary.PREF_MAX_CHARS, 24000));
			const truncated = text.length > maxChars;
			if (truncated) text = text.slice(0, maxChars);

			const parent = attachment.parentItem;
			const title = parent ? parent.getField("title") : attachment.getField("title");
			pw.close();
			pw = Summary.progress("AI summary", "Summarizing with " + model + " — this can take a minute…");

			const prompt = "You are helping a researcher. Summarize the academic paper below using only its text. "
				+ "Use these headings: Goal, Method, Key results, Limitations. Be concise (bullet points).\n\n"
				+ "Title: " + title + "\n\n" + text;
			const { text: summary, device } = await Summary.generate(model, prompt);
			if (!summary || !summary.trim()) throw new Error("The model returned an empty answer.");

			pw.close();
			const footer = "Generated locally by " + model + " on " + device
				+ (truncated ? "; only the first " + maxChars + " characters of the paper were used" : "") + ".";
			if (parent) {
				const note = new Zotero.Item("note");
				note.libraryID = parent.libraryID;
				note.parentID = parent.id;
				note.setNote(Summary.toHTML("AI summary", summary, footer));
				note.addTag("ai-summary");
				await note.saveTx();
				Summary.progress("AI summary done", "Saved as a child note of the item (" + device + ").", 6000);
			}
			else {
				Summary.alert("AI summary", summary + "\n\n" + footer);
			}
		}
		finally {
			Summary.running.delete(attachmentID);
			try { pw.close(); } catch (e) { /* already closed */ }
		}
	},

	esc(s) {
		return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	},

	// Minimal markdown -> HTML for the note (bold, bullets, paragraphs).
	toHTML(heading, md, footer) {
		const lines = Summary.esc(md.trim()).split(/\r?\n/);
		let html = "<h1>" + heading + "</h1>";
		let inList = false;
		for (const raw of lines) {
			const line = raw.trim().replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/^#+\s*/, "");
			const bullet = /^[-*•]\s+/.test(line);
			if (bullet && !inList) { html += "<ul>"; inList = true; }
			if (!bullet && inList) { html += "</ul>"; inList = false; }
			if (!line) continue;
			html += bullet ? "<li>" + line.replace(/^[-*•]\s+/, "") + "</li>" : "<p>" + line + "</p>";
		}
		if (inList) html += "</ul>";
		return html + "<p><i>" + Summary.esc(footer) + "</i></p>";
	},
};

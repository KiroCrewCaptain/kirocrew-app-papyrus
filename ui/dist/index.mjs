import { activeLocale, compareText, fmtDateTime, fmtNumber, useAppApi, useChatLauncher, useImeGuard, useLanguageGeneration } from "@kirocrew/app-sdk";
import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowDownToLine, ArrowLeft, ArrowUpFromLine, ChevronDown, ChevronRight, ChevronUp, Download, FileCheck2, FileDown, FilePlus2, FileText, FileWarning, Folder, GitBranch, Image, Library, Loader2, Pencil, Play, Plus, Ruler, ScrollText, Settings2, Sparkles, TerminalSquare, Trash2, XCircle } from "lucide-react";
import * as ui from "@kirocrew/app-sdk/ui";
import { Btn, Card, CardTitle, Clickable, ContentSkeleton, EmptyState, ErrorNotice, InfoTip, Input, Modal, PageHeader, SendBtn, StatCard } from "@kirocrew/app-sdk/ui";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
// src/api.ts
/** Before the root mounts (tests, or a module evaluated early): a plain fetch. */
var sameOriginFetch = { async raw(path, init) {
	const r = await fetch(path, {
		credentials: "same-origin",
		...init
	});
	if (!r.ok) {
		const text = await r.text().catch(() => r.statusText);
		throw Object.assign(/* @__PURE__ */ new Error(`API ${r.status}: ${text}`), {
			status: r.status,
			body: text
		});
	}
	return r;
} };
var transport = sameOriginFetch;
/** Route every call through *next* (the page root passes `useAppApi()`). */
function setTransport(next) {
	transport = next ?? sameOriginFetch;
}
function scopedFailure(err) {
	if (err && typeof err === "object" && "status" in err && typeof err.status === "number") {
		const body = err.body;
		return {
			status: err.status,
			body: typeof body === "string" ? body : ""
		};
	}
	return null;
}
var API = "/api/apps/papyrus";
/** Endpoint path for the compiled PDF. */
var PDF_PATH = "/pdf";
/** Thrown by every call below, carrying the server's own message when it sent one. */
var PapyrusApiError = class extends Error {
	status;
	/** Raw git/compiler output, when the endpoint returned any. */
	output;
	/** The backend's machine-readable `code`, or '' when it sent none. */
	code;
	/** For `invalid_project_name`: the refused character, or '' when none was named. */
	char;
	constructor(message, status, output = "", code = "", char = "") {
		super(message);
		this.name = "PapyrusApiError";
		this.status = status;
		this.output = output;
		this.code = code;
		this.char = char;
	}
};
function parseBody(text) {
	try {
		const parsed = JSON.parse(text);
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}
/** Prefer the backend's own `{error}`/`reason` over a bare "HTTP 500". */
function toError(failure) {
	const body = parseBody(failure.body);
	const reason = !body ? (/^\d{3}: (.+)$/s.exec(failure.body.trim())?.[1] ?? "").trim() : "";
	return new PapyrusApiError(body?.error || reason || `HTTP ${failure.status}`, failure.status, body?.output || "", typeof body?.code === "string" ? body.code : "", typeof body?.char === "string" ? body.char : "");
}
async function call(path, init) {
	let r;
	try {
		r = await transport.raw(`${API}${path}`, init);
	} catch (err) {
		const failure = scopedFailure(err);
		if (failure) throw toError(failure);
		throw err;
	}
	return r.json();
}
async function get(path, params = {}) {
	const q = new URLSearchParams(params);
	return call(`${path}${q.toString() ? `?${q.toString()}` : ""}`);
}
async function send(method, path, body) {
	return call(path, {
		method,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body)
	});
}
async function del(path, params) {
	return call(`${path}?${new URLSearchParams(params).toString()}`, { method: "DELETE" });
}
/**
* Compile is the one call that legitimately takes tens of seconds (a paper with a
* bibliography needs four compiler passes), so it does NOT go through the shared
* `send` error path: a non-ok response here is a FAILED COMPILE with a parseable
* log, not a transport error, and throwing would discard exactly the output the
* user needs to fix their document.
*/
async function compile(name) {
	let text;
	let status;
	try {
		const r = await transport.raw(`${API}/compile`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name })
		});
		status = r.status;
		text = await r.text();
	} catch (err) {
		const failure = scopedFailure(err);
		if (!failure) throw err;
		status = failure.status;
		text = failure.body;
	}
	const data = parseBody(text);
	if (data && "ok" in data) return data;
	return {
		ok: false,
		log: data?.error || `HTTP ${status}`,
		errors: [],
		duration_ms: 0
	};
}
/** URL of the compiled PDF, cache-busted so a recompile is never served stale. */
function pdfUrl(name, version) {
	return `${API}${PDF_PATH}?${new URLSearchParams({
		name,
		v: String(version)
	}).toString()}`;
}
var papyrusApi = {
	health: () => get("/health"),
	/**
	* Start the managed-compiler install. Answers 202 the moment the background job
	* starts, so the caller polls `/health` for `managed.job` rather than awaiting
	* the ~10-22MB transfer on this request.
	*/
	provisionCompiler: () => send("POST", "/compiler/provision", {}),
	listProjects: () => get("/projects"),
	createProject: (name) => send("POST", "/projects", { name }),
	cloneProject: (url, name) => send("POST", "/projects/clone", {
		url,
		name: name || ""
	}),
	getProject: (name) => get("/project", { name }),
	deleteProject: (name) => del("/project", { name }),
	listFiles: (name) => get("/files", { name }),
	readFile: (name, path) => get("/file", {
		name,
		path
	}),
	saveFile: (name, path, content) => send("PUT", "/file", {
		name,
		path,
		content
	}),
	createFile: (name, path) => send("POST", "/file", {
		name,
		path,
		content: ""
	}),
	deleteFile: (name, path) => del("/file", {
		name,
		path
	}),
	setMainFile: (name, path) => send("PUT", "/main", {
		name,
		path
	}),
	/**
	* Rename what the list shows for a paper. `name` (the directory) is untouched.
	*
	* An empty `title` CLEARS the override, and the response carries whatever wins
	* next — `name` — so the caller renders the answer instead of re-deriving it.
	*/
	setTitle: (name, title, generation) => send("PUT", "/title", {
		name,
		title,
		generation
	}),
	compile,
	gitStatus: (name) => get("/git", { name }),
	gitCommit: (name, message) => send("POST", "/git/commit", {
		name,
		message
	}),
	gitPush: (name) => send("POST", "/git/push", { name }),
	gitPull: (name) => send("POST", "/git/pull", { name })
};
// src/i18n.ts
/**
* The app's own strings. A bundle cannot read the dashboard's catalogs (those
* belong to the host and change with it), so every locale the dashboard ships is
* bundled here and looked up against the host's active language.
*
* The catalogs (`ui/i18n/<locale>.json`) are the `apps.papyrus.*` subtree copied
* from Kiro Crew's dashboard catalogs, plus the handful of shared dashboard
* strings the page used (a resize grip's label, the confirm dialog's Cancel, the
* script names), under the SAME key paths, so every call site reads as it did in
* the built-in.
*
* Lookup order: the exact locale (`pt`, `zh-CN`), then its base language, then
* English, then the key itself. A numeric `count` selects the plural form the
* locale's rules name (`_one`, `_few`, `_many`, `_other`), as the dashboard's own
* catalogs are keyed. `{{name}}` placeholders are filled from `vars`; one with no
* value is left as written.
*
* `t` reads the language at call time. The root component subscribes to the
* host's language changes (`useLanguageGeneration`), and its re-render reaches
* every child, so a language switch repaints the page without a reload.
*/
var CATALOGS = {
	bn: {
		apps: /* @__PURE__ */ JSON.parse("{\"papyrus\":{\"coAuthor\":{\"close_co_author_panel\":\"সহ-লেখক প্যানেল বন্ধ করুন\",\"close_panel\":\"প্যানেল বন্ধ করুন — সেশন খোলা থাকবে\",\"co_author\":\"সহ-লেখক\",\"co_author_chat\":\"সহ-লেখক চ্যাট\",\"no_co_author_session_for_this_paper_yet\":\"এই পেপারের জন্য এখনও কোনও সহ-লেখক সেশন নেই।\",\"open_in_chat_page\":\"চ্যাট পৃষ্ঠায় খুলুন\",\"start_a_session\":\"একটি সেশন শুরু করুন\",\"starting_session\":\"সেশন শুরু হচ্ছে…\"},\"diagnostics\":{\"jump_to_line\":\"{{line}} নম্বর লাইনে যান\",\"line_short\":\"লা{{line}}\",\"no_messages\":\"কম্পাইলার কিছুই জানায়নি।\",\"typesetting_hints_one\":\"{{count}}টি টাইপসেটিং পরামর্শ\",\"typesetting_hints_other\":\"{{count}}টি টাইপসেটিং পরামর্শ\"},\"fileTree\":{\"delete_file\":\"{{file}} মুছুন\",\"files\":\"ফাইল\",\"main\":\"মূল\",\"new_file\":\"নতুন ফাইল\",\"no_source_files\":\"কোনও সোর্স ফাইল নেই।\"},\"manifest\":{\"configuration_1\":\"অ্যাপ থেকে managed Tectonic install করুন অথবা tectonic বা pdflatex-কে PATH-এ রাখুন, তারপর paper তৈরি করুন বা আগে থেকে non-interactive Git credential সেট করা repository clone করুন।\",\"description\":\"লাইভ PDF প্রিভিউ আর একজন AI সহ-লেখক নিয়ে একটি LaTeX পেপার এডিটর। ভাগ করা প্যানের এডিটরে লেখো, pdflatex বা tectonic দিয়ে কম্পাইল করতে Cmd+S (Windows ও Linux-এ Ctrl+S) চাপো, আর নিজের সোর্সের পাশেই তৈরি হওয়া PDF পড়ো। কম্পাইলের ত্রুটিগুলো ক্লিক করার মতো একটি তালিকায় সাজানো হয়, যা সোজা সমস্যার লাইনে নিয়ে যায়। যেকোনো git রিমোট থেকে আগে থেকে থাকা কোনো পেপার ক্লোন করো, তারপর টুলবার থেকেই কমিট ও পুশ করো। সহ-লেখক প্যানেলটি পেপারের জন্য নির্দিষ্ট একটি সত্যিকারের Kiro Crew চ্যাট সেশন, তাই তুমি PDF আপডেট হতে দেখতে দেখতেই এজেন্ট তোমার LaTeX পড়তে ও সম্পাদনা করতে পারে।\",\"display_name\":\"Papyrus\",\"highlight_1\":\"পাশে লাইভ PDF প্রিভিউ নিয়ে ভাগ করা প্যানের LaTeX এডিটর\",\"highlight_2\":\"সেভ করলেই কম্পাইল (Cmd+S, বা Windows ও Linux-এ Ctrl+S) — pdflatex বা tectonic দিয়ে, সঙ্গে bibtex চক্রটিও চালিয়ে দেওয়া হয়\",\"highlight_3\":\"TeX ইনস্টল করা নেই? এক ক্লিকেই যাচাই করা একটি Tectonic কম্পাইলার Papyrus-এর নিজের ফোল্ডারে বসে যায়\",\"highlight_4\":\"কম্পাইলারের ত্রুটি ও সতর্কতা ক্লিক করার মতো একটি তালিকায় সাজানো হয়, যা সোজা সেই লাইনে নিয়ে যায়\",\"highlight_5\":\"পেপারের জন্য নির্দিষ্ট AI সহ-লেখক চ্যাট — তুমি যে LaTeX দেখছ সেটিই পড়ে ও সম্পাদনা করে\",\"highlight_6\":\"যেকোনো git রিমোট থেকে একটি পেপার ক্লোন করো, তারপর টুলবার থেকেই কমিট, পুল ও পুশ করো\",\"highlight_7\":\"কম্পাইলার কখনও shell escape দিয়ে চলে না, তাই ক্ষতিকর কোনো .tex ফাইল কমান্ড চালাতে পারে না\",\"page_label\":\"Papyrus\",\"use_case_1\":\"compiled PDF-এর পাশে LaTeX paper লিখুন, build error থেকে সরাসরি source-এ যান এবং paper-এ সীমাবদ্ধ agent-এর সঙ্গে কাজ করুন।\"},\"page\":{\"actions\":\"কাজ\",\"clone\":\"ক্লোন করুন\",\"clone_url\":\"রিপোজিটরি URL\",\"clone_url_placeholder\":\"একটি git URL থেকে ক্লোন করুন…\",\"cloning\":\"ক্লোন হচ্ছে…\",\"compiled_count_label\":\"কম্পাইল হয়েছে\",\"compiler\":\"কম্পাইলার\",\"compiler_tip\":\"{{productName}} চালানো মেশিনে পাওয়া LaTeX কম্পাইলার। Papyrus আগে pdflatex বেছে নেয়, না পেলে tectonic।\",\"create\":\"তৈরি করুন\",\"create_one_above_or_clone_an_existing_repository\":\"উপরে একটি তৈরি করুন, বা বিদ্যমান কোনও রিপোজিটরি ক্লোন করুন।\",\"delete_paper\":\"{{name}} মুছুন\",\"delete_paper_confirm\":\"“{{name}}” এবং এর সব ফাইল মুছে ফেলবেন? এটি আর ফেরানো যাবে না।\",\"downloading_compiler_progress\":\"ডাউনলোড হচ্ছে… {{total}}-এর মধ্যে {{done}}\",\"install_compiler\":\"কম্পাইলার ইনস্টল করুন\",\"installing_compiler\":\"ইনস্টল করা হচ্ছে…\",\"invalid_project_name\":\"পেপারের নামই তার ফোল্ডারের নাম হয়, তাই এতে শুধু ছোট হাতের ল্যাটিন অক্ষর (a–z), অঙ্ক (0–9), বিন্দু, হাইফেন আর আন্ডারস্কোর থাকতে পারে। নাম কোনো অক্ষর বা অঙ্ক দিয়ে শুরু হতে হবে এবং সর্বোচ্চ 64টি অক্ষরের হতে পারে।\",\"invalid_project_name_char\":\"“{{char}}” পেপারের নামে ব্যবহার করা যায় না। ছোট হাতের a–z, 0–9, .\xA0-⁠\xA0_ ব্যবহার করো।\",\"invalid_project_name_letter\":\"“{{char}}” ({{script}}, {{code}}) পেপারের নামে ব্যবহার করা যায় না। ছোট হাতের a–z, 0–9, .\xA0-⁠\xA0_ ব্যবহার করো।\",\"last_edited\":\"সর্বশেষ সম্পাদনা\",\"latex_papers_with_a_live_pdf_preview\":\"লাইভ PDF প্রিভিউ সহ LaTeX পেপার\",\"new_paper_name\":\"নতুন পেপারের নাম\",\"new_paper_name_placeholder\":\"আপনার পেপারের নাম দিন…\",\"no_compiler_found_install_texlive_or_tectonic\":\"এই মেশিনে কোনও LaTeX কম্পাইলার পাওয়া যায়নি। কম্পাইল করতে TeX Live (pdflatex) বা tectonic ইনস্টল করুন।\",\"no_compiler_install_bundled_prompt\":\"এই মেশিনে কোনও LaTeX কম্পাইলার পাওয়া যায়নি। সঙ্গে দেওয়া Tectonic কম্পাইলার ইনস্টল করুন — একটিই যাচাই করা ডাউনলোড, যা Papyrus-এর নিজের ফোল্ডারেই থাকে।\",\"no_papers_yet\":\"এখনও কোনও পেপার নেই\",\"none_found\":\"কিছুই নেই\",\"paper\":\"পেপার\",\"paper_name\":\"পেপারের নাম\",\"papers\":\"পেপার\",\"papyrus\":\"Papyrus\",\"pdf\":\"PDF\",\"pdf_missing_status\":\"কম্পাইল হয়নি\",\"pdf_ready_status\":\"প্রস্তুত\",\"rename_config_refused\":\"নামটি সেভ হয়নি: Papyrus এই পেপারের সেটিংস বদলাতে পারছে না।\",\"rename_paper\":\"{{name}} এর নাম বদলাও\",\"rename_paper_replaced\":\"লিস্ট লোড হওয়ার পর এই পেপারটি বদলেছে। লিস্ট এখন হালনাগাদ; নামটি আবার সেভ করতে Enter চাপো।\",\"rename_title_rejected\":\"দেখা যায় এমন অক্ষর দিয়ে একটি নাম লেখো, অথবা আবার {{name}} দেখাতে ঘরটি খালি করো।\",\"start_a_paper\":\"একটি পেপার শুরু করুন\",\"start_a_paper_tip\":\"প্রমিত article টেমপ্লেট থেকে একটি খালি পেপার তৈরি করুন, বা কোনও git রিমোট থেকে ক্লোন করুন — .tex ফাইল আছে এমন যে কোনওটিই চলবে।\",\"verifying_compiler\":\"যাচাই করা হচ্ছে…\",\"your_papers\":\"আপনার পেপার\"},\"preview\":{\"compile_to_see_the_pdf\":\"PDF দেখতে কম্পাইল করুন।\",\"download_pdf\":\"PDF ডাউনলোড করুন\",\"pdf_preview\":\"PDF প্রিভিউ\"},\"workspace\":{\"co_author\":\"সহ-লেখক\",\"co_author_conflict\":\"সহ-লেখক এই ফাইলটি পরিবর্তন করেছেন\",\"co_author_conflict_discard\":\"আমার পরিবর্তন বাতিল করে আবার লোড করুন\",\"co_author_conflict_discard_button\":\"পরিবর্তন বাতিল করুন\",\"co_author_conflict_discard_confirm\":\"“{{file}}”-এ আপনার অসংরক্ষিত পরিবর্তন বাতিল করে সহ-লেখকের সংস্করণ লোড করা হবে। এটি আর ফেরানো যাবে না।\",\"co_author_conflict_discard_title\":\"অসংরক্ষিত পরিবর্তন বাতিল করবেন?\",\"commit_and_push\":\"কমিট ও পুশ করুন\",\"commit_message_prompt\":\"এই কমিটের বর্ণনা দিন। এতে গবেষণাপত্রের সব পরিবর্তন যুক্ত হবে।\",\"compile\":\"কম্পাইল করুন\",\"compiling\":\"কম্পাইল হচ্ছে…\",\"context_not_attached\":\"পরবর্তী মেসেজে পেপারটির উল্লেখ করো যাতে সহ-লেখক এটি দেখতে পারে। উল্লেখ করার পরে এই বিজ্ঞপ্তিটি বন্ধ করতে পারো।\",\"context_notice_title\":\"এই পেপারটি সহ-লেখকের সাথে শেয়ার করা যায়নি\",\"cursor_position\":\"লা. {{line}}, কল. {{column}}\",\"delete_file_confirm\":\"“{{file}}” মুছে ফেলবেন?\",\"download_pdf\":\"PDF ডাউনলোড করুন\",\"editing\":\"{{file}} সম্পাদনা করছেন\",\"editing_unsaved\":\"{{file}} সম্পাদনা করছেন — সংরক্ষিত হয়নি\",\"error_count_one\":\"{{count}}টি ত্রুটি\",\"error_count_other\":\"{{count}}টি ত্রুটি\",\"git_branch\":\"বর্তমান ব্রাঞ্চ\",\"log\":\"লগ\",\"main_document\":\"মূল নথি\",\"new_file_prompt\":\"নতুন ফাইলের নাম দিন, যেমন methods.tex\",\"papers\":\"পেপার\",\"pull\":\"পুল করুন\",\"save_and_compile_hint\":\"সংরক্ষণ করে কম্পাইল করতে Cmd+S (Windows ও Linux-এ Ctrl+S) চাপুন।\",\"session_title\":\"Papyrus: {{name}}\",\"warning_count_one\":\"{{count}}টি সতর্কতা\",\"warning_count_other\":\"{{count}}টি সতর্কতা\",\"word_count_one\":\"{{count}}টি শব্দ\",\"word_count_other\":\"{{count}}টি শব্দ\"}},\"specBuilder\":{\"components\":{\"specDetail\":{\"resize_document_panel\":\"নথি প্যানেলের আকার বদলান\"}}}}"),
		components: {
			"confirmDialog": { "cancel": "বাতিল" },
			"resizeHandle": { "drag_to_resize": "আকার বদলাতে টানুন" }
		},
		lib: { "scriptLabel": {
			"cyrillic": "সিরিলিক অক্ষর",
			"greek": "গ্রিক অক্ষর",
			"latin": "ল্যাটিন অক্ষর",
			"other": "অক্ষর"
		} },
		pages: { "chat": {
			"fileBrowserRail": { "resize": "ফাইল ব্রাউজারের আকার পরিবর্তন করুন" },
			"sidePanel": { "resize_panel": "প্যানেলের আকার বদলান" }
		} }
	},
	de: {
		apps: {
			"papyrus": {
				"coAuthor": {
					"close_co_author_panel": "Koautor-Bereich schließen",
					"close_panel": "Bereich schließen — die Sitzung bleibt offen",
					"co_author": "Koautor",
					"co_author_chat": "Koautor-Chat",
					"no_co_author_session_for_this_paper_yet": "Für dieses Paper gibt es noch keine Koautor-Sitzung.",
					"open_in_chat_page": "Auf der Chat-Seite öffnen",
					"start_a_session": "Sitzung starten",
					"starting_session": "Sitzung wird gestartet…"
				},
				"diagnostics": {
					"jump_to_line": "Zu Zeile {{line}} springen",
					"line_short": "Z{{line}}",
					"no_messages": "Der Compiler hat nichts gemeldet.",
					"typesetting_hints_one": "{{count}} Satzhinweis",
					"typesetting_hints_other": "{{count}} Satzhinweise"
				},
				"fileTree": {
					"delete_file": "{{file}} löschen",
					"files": "Dateien",
					"main": "Haupt",
					"new_file": "Neue Datei",
					"no_source_files": "Keine Quelldateien."
				},
				"manifest": {
					"configuration_1": "Installiere das verwaltete Tectonic aus der App oder stelle tectonic beziehungsweise pdflatex über PATH bereit; erstelle dann ein Paper oder klone ein Repository mit bereits konfigurierten nicht interaktiven Git-Zugangsdaten.",
					"description": "Ein LaTeX-Editor für Paper mit Live-PDF-Vorschau und einem KI-Koautor. Schreibe in einem geteilten Editor, drücke Cmd+S (Ctrl+S unter Windows und Linux), um mit pdflatex oder tectonic zu kompilieren, und lies das gerenderte PDF neben deiner Quelle. Kompilierfehler werden zu einer klickbaren Liste geparst, die zur betroffenen Zeile springt. Klone ein bestehendes Paper von einem beliebigen git-Remote, committe und pushe dann aus der Werkzeugleiste. Der Koautor-Bereich ist eine echte Chat-Sitzung von Kiro Crew mit dem Paper als Kontext, sodass der Agent dein LaTeX lesen und bearbeiten kann, während du zusiehst, wie das PDF aktualisiert wird.",
					"display_name": "Papyrus",
					"highlight_1": "Geteilter LaTeX-Editor mit einer Live-PDF-Vorschau daneben",
					"highlight_2": "Kompilieren beim Speichern (Cmd+S, unter Windows und Linux Ctrl+S) über pdflatex oder tectonic, der bibtex-Zyklus läuft für dich mit",
					"highlight_3": "Kein TeX installiert? Ein Klick installiert einen geprüften Tectonic-Compiler in einen eigenen Ordner von Papyrus",
					"highlight_4": "Compiler-Fehler und -Warnungen werden zu einer klickbaren Liste geparst, die zur Zeile springt",
					"highlight_5": "KI-Koautor-Chat mit dem Paper als Kontext — er liest und bearbeitet das LaTeX, das du vor dir hast",
					"highlight_6": "Klone ein Paper von einem beliebigen git-Remote und committe, pulle und pushe dann aus der Werkzeugleiste",
					"highlight_7": "Führt den Compiler nie mit Shell-Escape aus, damit eine bösartige .tex-Datei keine Befehle ausführen kann",
					"page_label": "Papyrus",
					"use_case_1": "Schreibe ein LaTeX-Paper neben dem kompilierten PDF, springe von Build-Fehlern zur Quelle und arbeite mit einem auf das Paper begrenzten Agenten zusammen."
				},
				"page": {
					"actions": "Aktionen",
					"clone": "Klonen",
					"clone_url": "Repository-URL",
					"clone_url_placeholder": "Von einer git-URL klonen…",
					"cloning": "Wird geklont…",
					"compiled_count_label": "Kompiliert",
					"compiler": "Compiler",
					"compiler_tip": "Der LaTeX-Compiler auf dem Rechner, der {{productName}} ausführt. Papyrus bevorzugt pdflatex und greift sonst auf tectonic zurück.",
					"create": "Erstellen",
					"create_one_above_or_clone_an_existing_repository": "Erstellen Sie oben eines, oder klonen Sie ein bestehendes Repository.",
					"delete_paper": "{{name}} löschen",
					"delete_paper_confirm": "„{{name}}“ und alle zugehörigen Dateien löschen? Dies kann nicht rückgängig gemacht werden.",
					"downloading_compiler_progress": "Wird heruntergeladen… {{done}} von {{total}}",
					"install_compiler": "Compiler installieren",
					"installing_compiler": "Installation läuft…",
					"invalid_project_name": "Paper-Namen werden zu Ordnernamen und dürfen daher nur Kleinbuchstaben des lateinischen Alphabets (a–z), Ziffern (0–9), Punkte, Bindestriche und Unterstriche enthalten, müssen mit einem Buchstaben oder einer Ziffer beginnen und dürfen höchstens 64 Zeichen lang sein.",
					"invalid_project_name_char": "„{{char}}“ kann in einem Paper-Namen nicht verwendet werden. Nutze Kleinbuchstaben a–z, 0–9, .\xA0-⁠\xA0_",
					"invalid_project_name_letter": "„{{char}}“ ({{script}}, {{code}}) kann in einem Paper-Namen nicht verwendet werden. Nutze Kleinbuchstaben a–z, 0–9, .\xA0-⁠\xA0_",
					"last_edited": "Zuletzt bearbeitet",
					"latex_papers_with_a_live_pdf_preview": "LaTeX-Papers mit laufender PDF-Vorschau",
					"new_paper_name": "Name des neuen Papers",
					"new_paper_name_placeholder": "Benennen Sie Ihr Paper…",
					"no_compiler_found_install_texlive_or_tectonic": "Auf diesem Rechner wurde kein LaTeX-Compiler gefunden. Installieren Sie TeX Live (pdflatex) oder tectonic, um zu kompilieren.",
					"no_compiler_install_bundled_prompt": "Auf diesem Rechner wurde kein LaTeX-Compiler gefunden. Installieren Sie den mitgelieferten Tectonic-Compiler — ein einzelner geprüfter Download, der im eigenen Ordner von Papyrus bleibt.",
					"no_papers_yet": "Noch keine Papers",
					"none_found": "Keiner",
					"paper": "Paper",
					"paper_name": "Name des Papers",
					"papers": "Papers",
					"papyrus": "Papyrus",
					"pdf": "PDF",
					"pdf_missing_status": "Nicht kompiliert",
					"pdf_ready_status": "Fertig",
					"rename_config_refused": "Der Name wurde nicht gespeichert: Papyrus kann die Einstellungen dieses Papers nicht ändern.",
					"rename_paper": "{{name}} umbenennen",
					"rename_paper_replaced": "Dieses Paper hat sich seit dem Laden der Liste geändert. Die Liste ist jetzt aktuell; drücke die Eingabetaste, um den Namen erneut zu speichern.",
					"rename_title_rejected": "Gib einen Namen mit sichtbaren Zeichen ein oder leere das Feld, um wieder {{name}} anzuzeigen.",
					"start_a_paper": "Ein Paper beginnen",
					"start_a_paper_tip": "Erstellen Sie ein leeres Paper aus der Standardvorlage „article“, oder klonen Sie eines von einem git-Remote — alles mit einer .tex-Datei funktioniert.",
					"verifying_compiler": "Wird überprüft…",
					"your_papers": "Ihre Papers"
				},
				"preview": {
					"compile_to_see_the_pdf": "Kompilieren, um das PDF zu sehen.",
					"download_pdf": "PDF herunterladen",
					"pdf_preview": "PDF-Vorschau"
				},
				"workspace": {
					"co_author": "Koautor",
					"co_author_conflict": "Co-Autor hat diese Datei geändert",
					"co_author_conflict_discard": "Meine Änderungen verwerfen und neu laden",
					"co_author_conflict_discard_button": "Änderungen verwerfen",
					"co_author_conflict_discard_confirm": "Verwirft nicht gespeicherte Änderungen an „{{file}}“ und lädt die Version des Co-Autors. Dies kann nicht rückgängig gemacht werden.",
					"co_author_conflict_discard_title": "Nicht gespeicherte Änderungen verwerfen?",
					"commit_and_push": "Committen & senden",
					"commit_message_prompt": "Beschreibe diesen Commit. Er erfasst jede Änderung im Papier.",
					"compile": "Kompilieren",
					"compiling": "Wird kompiliert…",
					"context_not_attached": "Erwähne das Paper in deiner nächsten Nachricht, damit der Koautor es sehen kann. Du kannst diesen Hinweis nach der Erwähnung schließen.",
					"context_notice_title": "Paper konnte nicht an den Koautor übergeben werden",
					"cursor_position": "Z. {{line}}, Sp. {{column}}",
					"delete_file_confirm": "„{{file}}“ löschen?",
					"download_pdf": "PDF herunterladen",
					"editing": "{{file}} wird bearbeitet",
					"editing_unsaved": "{{file}} wird bearbeitet — nicht gespeichert",
					"error_count_one": "{{count}} Fehler",
					"error_count_other": "{{count}} Fehler",
					"git_branch": "Aktueller Branch",
					"log": "Protokoll",
					"main_document": "Hauptdokument",
					"new_file_prompt": "Benennen Sie die neue Datei, zum Beispiel methods.tex",
					"papers": "Papers",
					"pull": "Holen",
					"save_and_compile_hint": "Drücken Sie Cmd+S (Ctrl+S unter Windows und Linux), um zu speichern und zu kompilieren.",
					"session_title": "Papyrus: {{name}}",
					"warning_count_one": "{{count}} Warnung",
					"warning_count_other": "{{count}} Warnungen",
					"word_count_one": "{{count}} Wort",
					"word_count_other": "{{count}} Wörter"
				}
			},
			"specBuilder": { "components": { "specDetail": { "resize_document_panel": "Größe des Dokumentbereichs ändern" } } }
		},
		components: {
			"confirmDialog": { "cancel": "Abbrechen" },
			"resizeHandle": { "drag_to_resize": "Ziehen zum Ändern der Größe" }
		},
		lib: { "scriptLabel": {
			"cyrillic": "kyrillischer Buchstabe",
			"greek": "griechischer Buchstabe",
			"latin": "lateinischer Buchstabe",
			"other": "Zeichen"
		} },
		pages: { "chat": {
			"fileBrowserRail": { "resize": "Dateibrowser-Größe ändern" },
			"sidePanel": { "resize_panel": "Größe des Panels ändern" }
		} }
	},
	en: {
		apps: {
			"papyrus": {
				"coAuthor": {
					"close_co_author_panel": "Close co-author panel",
					"close_panel": "Close the panel — the session stays open",
					"co_author": "Co-author",
					"co_author_chat": "Co-author chat",
					"no_co_author_session_for_this_paper_yet": "No co-author session for this paper yet.",
					"open_in_chat_page": "Open in the chat page",
					"start_a_session": "Start a session",
					"starting_session": "Starting session…"
				},
				"diagnostics": {
					"jump_to_line": "Go to line {{line}}",
					"line_short": "L{{line}}",
					"no_messages": "The compiler reported nothing.",
					"typesetting_hints_one": "{{count}} typesetting hint",
					"typesetting_hints_other": "{{count}} typesetting hints"
				},
				"editor": {},
				"fileTree": {
					"delete_file": "Delete {{file}}",
					"files": "Files",
					"main": "Main",
					"new_file": "New file",
					"no_source_files": "No source files."
				},
				"manifest": {
					"configuration_1": "Install managed Tectonic from the app or put tectonic or pdflatex on PATH, then create a paper or clone a repository with non-interactive Git credentials already configured.",
					"description": "A LaTeX paper editor with live PDF preview and an AI co-author. Write in a split-pane editor, press Cmd+S (Ctrl+S on Windows and Linux) to compile with pdflatex or tectonic, and read the rendered PDF beside your source. Compilation errors are parsed into a clickable list that jumps to the offending line. Clone an existing paper from any git remote, then commit and push from the toolbar. The co-author panel is a real Kiro Crew chat session scoped to the paper, so the agent can read and edit your LaTeX while you watch the PDF update.",
					"display_name": "Papyrus",
					"highlight_1": "Split-pane LaTeX editor with a live PDF preview beside it",
					"highlight_2": "Compile on save (Cmd+S, or Ctrl+S on Windows and Linux) via pdflatex or tectonic, with the bibtex cycle run for you",
					"highlight_3": "No TeX installed? One click installs a verified Tectonic compiler into Papyrus’s own folder",
					"highlight_4": "Compiler errors and warnings parsed into a clickable list that jumps to the line",
					"highlight_5": "AI co-author chat scoped to the paper — it reads and edits the LaTeX you are looking at",
					"highlight_6": "Clone a paper from any git remote, then commit, pull, and push from the toolbar",
					"highlight_7": "Never runs the compiler with shell escape, so a hostile .tex file cannot execute commands",
					"page_label": "Papyrus",
					"use_case_1": "Write a LaTeX paper beside its compiled PDF, jump from build errors to source, and collaborate with a paper-scoped agent."
				},
				"page": {
					"actions": "Actions",
					"clone": "Clone",
					"clone_url": "Repository URL",
					"clone_url_placeholder": "Clone from a git URL…",
					"cloning": "Cloning…",
					"compiled_count_label": "Compiled",
					"compiler": "Compiler",
					"compiler_tip": "The LaTeX compiler found on the machine running {{productName}}. Papyrus prefers pdflatex and falls back to tectonic.",
					"create": "Create",
					"create_one_above_or_clone_an_existing_repository": "Create one above, or clone an existing repository.",
					"delete_paper": "Delete {{name}}",
					"delete_paper_confirm": "Delete “{{name}}” and all of its files? This cannot be undone.",
					"downloading_compiler_progress": "Downloading… {{done}} of {{total}}",
					"install_compiler": "Install compiler",
					"installing_compiler": "Installing…",
					"invalid_project_name": "Paper names become folder names, so they can use only lowercase Latin letters (a–z), digits (0–9), dots, hyphens and underscores, must start with a letter or digit, and can be at most 64 characters.",
					"invalid_project_name_char": "“{{char}}” can’t be used in a paper name. Use lowercase a–z, 0–9, .\xA0-⁠\xA0_",
					"invalid_project_name_letter": "“{{char}}” ({{script}}, {{code}}) can’t be used in a paper name. Use lowercase a–z, 0–9, .\xA0-⁠\xA0_",
					"last_edited": "Last edited",
					"latex_papers_with_a_live_pdf_preview": "LaTeX papers with a live PDF preview",
					"new_paper_name": "New paper name",
					"new_paper_name_placeholder": "Name your paper…",
					"no_compiler_found_install_texlive_or_tectonic": "No LaTeX compiler was found on this machine. Install TeX Live (pdflatex) or tectonic to compile.",
					"no_compiler_install_bundled_prompt": "No LaTeX compiler was found on this machine. Install the bundled Tectonic compiler — a single verified download, kept inside Papyrus's own folder.",
					"no_papers_yet": "No papers yet",
					"none_found": "None",
					"paper": "Paper",
					"paper_name": "Paper name",
					"papers": "Papers",
					"papyrus": "Papyrus",
					"pdf": "PDF",
					"pdf_missing_status": "Not compiled",
					"pdf_ready_status": "Ready",
					"rename_config_refused": "The name wasn’t saved: Papyrus can’t change this paper’s settings.",
					"rename_paper": "Rename {{name}}",
					"rename_paper_replaced": "This paper changed since the list loaded. The list is up to date now; press Enter to save the name again.",
					"rename_title_rejected": "Type a name with visible characters, or clear the field to show {{name}} again.",
					"start_a_paper": "Start a paper",
					"start_a_paper_tip": "Create an empty paper from a standard article template, or clone one from a git remote — anything with a .tex file works.",
					"verifying_compiler": "Verifying…",
					"your_papers": "Your papers"
				},
				"preview": {
					"compile_to_see_the_pdf": "Compile to see the PDF.",
					"download_pdf": "Download the PDF",
					"pdf_preview": "PDF preview"
				},
				"workspace": {
					"co_author": "Co-author",
					"co_author_conflict": "Co-author changed this file",
					"co_author_conflict_discard": "Discard my changes and reload",
					"co_author_conflict_discard_button": "Discard changes",
					"co_author_conflict_discard_confirm": "Discards your unsaved changes to “{{file}}” and loads the co-author’s version. This cannot be undone.",
					"co_author_conflict_discard_title": "Discard unsaved changes?",
					"commit_and_push": "Commit & Push",
					"commit_message_prompt": "Describe this commit. It stages every change in the paper.",
					"compile": "Compile",
					"compiling": "Compiling…",
					"context_not_attached": "Mention the paper in your next message so the co-author can see it. You can dismiss this once you've mentioned it.",
					"context_notice_title": "Couldn't share this paper with the co-author",
					"cursor_position": "Ln {{line}}, Col {{column}}",
					"delete_file_confirm": "Delete “{{file}}”?",
					"download_pdf": "Download PDF",
					"editing": "Editing {{file}}",
					"editing_unsaved": "Editing {{file}} — unsaved",
					"error_count_one": "{{count}} error",
					"error_count_other": "{{count}} errors",
					"git_branch": "Current branch",
					"log": "Log",
					"main_document": "Main document",
					"new_file_prompt": "Name the new file, for example methods.tex",
					"papers": "Papers",
					"pull": "Pull",
					"save_and_compile_hint": "Press Cmd+S (Ctrl+S on Windows and Linux) to save and compile.",
					"session_title": "Papyrus: {{name}}",
					"warning_count_one": "{{count}} warning",
					"warning_count_other": "{{count}} warnings",
					"word_count_one": "{{count}} word",
					"word_count_other": "{{count}} words"
				}
			},
			"specBuilder": { "components": { "specDetail": { "resize_document_panel": "Resize document panel" } } }
		},
		components: {
			"confirmDialog": { "cancel": "Cancel" },
			"resizeHandle": { "drag_to_resize": "Drag to resize" }
		},
		lib: { "scriptLabel": {
			"cyrillic": "Cyrillic letter",
			"greek": "Greek letter",
			"latin": "Latin letter",
			"other": "character"
		} },
		pages: { "chat": {
			"fileBrowserRail": { "resize": "Resize file browser" },
			"sidePanel": { "resize_panel": "Resize panel" }
		} }
	},
	es: {
		apps: {
			"papyrus": {
				"coAuthor": {
					"close_co_author_panel": "Cerrar el panel de coautoría",
					"close_panel": "Cerrar el panel: la sesión sigue abierta",
					"co_author": "Coautor",
					"co_author_chat": "Chat de coautoría",
					"no_co_author_session_for_this_paper_yet": "Todavía no hay sesión de coautoría para este artículo.",
					"open_in_chat_page": "Abrir en la página de chat",
					"start_a_session": "Iniciar una sesión",
					"starting_session": "Iniciando la sesión…"
				},
				"diagnostics": {
					"jump_to_line": "Ir a la línea {{line}}",
					"line_short": "L{{line}}",
					"no_messages": "El compilador no informó nada.",
					"typesetting_hints_many": "{{count}} avisos de composición",
					"typesetting_hints_one": "{{count}} aviso de composición",
					"typesetting_hints_other": "{{count}} avisos de composición"
				},
				"fileTree": {
					"delete_file": "Eliminar {{file}}",
					"files": "Archivos",
					"main": "Principal",
					"new_file": "Nuevo archivo",
					"no_source_files": "No hay archivos fuente."
				},
				"manifest": {
					"configuration_1": "Instala Tectonic gestionado desde la app o añade tectonic o pdflatex a PATH; después crea un artículo o clona un repositorio con credenciales de Git no interactivas ya configuradas.",
					"description": "Un editor de artículos en LaTeX con vista previa del PDF en vivo y un coautor con IA. Escribe en un editor de panel dividido, pulsa Cmd+S (Ctrl+S en Windows y Linux) para compilar con pdflatex o tectonic, y lee el PDF renderizado junto a tu código fuente. Los errores de compilación se analizan en una lista donde puedes hacer clic para saltar a la línea que los provoca. Clona un artículo existente desde cualquier remoto de git y luego confirma y envía los cambios desde la barra de herramientas. El panel del coautor es una sesión de chat real de Kiro Crew acotada al artículo, así que el agente puede leer y editar tu LaTeX mientras ves cómo se actualiza el PDF.",
					"display_name": "Papyrus",
					"highlight_1": "Editor de LaTeX en panel dividido con una vista previa del PDF en vivo al lado",
					"highlight_2": "Compila al guardar (Cmd+S, o Ctrl+S en Windows y Linux) con pdflatex o tectonic, y ejecuta el ciclo de bibtex por ti",
					"highlight_3": "¿No tienes TeX instalado? Un clic instala un compilador Tectonic verificado en la carpeta propia de Papyrus",
					"highlight_4": "Errores y advertencias del compilador analizados en una lista donde puedes hacer clic para saltar a la línea",
					"highlight_5": "Chat con el coautor de IA acotado al artículo — lee y edita el LaTeX que tienes delante",
					"highlight_6": "Clona un artículo desde cualquier remoto de git y luego confirma, trae y envía los cambios desde la barra de herramientas",
					"highlight_7": "Nunca ejecuta el compilador con shell escape, así que un archivo .tex hostil no puede ejecutar comandos",
					"page_label": "Papyrus",
					"use_case_1": "Escribe un artículo en LaTeX junto a su PDF compilado, salta de los errores de compilación al código fuente y colabora con un agente limitado al artículo."
				},
				"page": {
					"actions": "Acciones",
					"clone": "Clonar",
					"clone_url": "URL del repositorio",
					"clone_url_placeholder": "Clonar desde una URL de git…",
					"cloning": "Clonando…",
					"compiled_count_label": "Compilados",
					"compiler": "Compilador",
					"compiler_tip": "El compilador de LaTeX encontrado en la máquina que ejecuta {{productName}}. Papyrus prefiere pdflatex y recurre a tectonic.",
					"create": "Crear",
					"create_one_above_or_clone_an_existing_repository": "Crea uno arriba o clona un repositorio existente.",
					"delete_paper": "Eliminar {{name}}",
					"delete_paper_confirm": "¿Eliminar “{{name}}” y todos sus archivos? Esta acción no se puede deshacer.",
					"downloading_compiler_progress": "Descargando… {{done}} de {{total}}",
					"install_compiler": "Instalar compilador",
					"installing_compiler": "Instalando…",
					"invalid_project_name": "Los nombres de los artículos se convierten en nombres de carpeta, así que solo pueden contener letras latinas minúsculas (a–z), dígitos (0–9), puntos, guiones y guiones bajos, deben empezar con una letra o un dígito y tener como máximo 64 caracteres.",
					"invalid_project_name_char": "“{{char}}” no se puede usar en el nombre de un artículo. Usa letras minúsculas a–z, 0–9, .\xA0-⁠\xA0_",
					"invalid_project_name_letter": "“{{char}}” ({{script}}, {{code}}) no se puede usar en el nombre de un artículo. Usa letras minúsculas a–z, 0–9, .\xA0-⁠\xA0_",
					"last_edited": "Última edición",
					"latex_papers_with_a_live_pdf_preview": "Artículos en LaTeX con vista previa del PDF en vivo",
					"new_paper_name": "Nombre del nuevo artículo",
					"new_paper_name_placeholder": "Nombra tu artículo…",
					"no_compiler_found_install_texlive_or_tectonic": "No se encontró ningún compilador de LaTeX en esta máquina. Instala TeX Live (pdflatex) o tectonic para compilar.",
					"no_compiler_install_bundled_prompt": "No se encontró ningún compilador de LaTeX en esta máquina. Instala el compilador Tectonic incluido: una sola descarga verificada, que se guarda dentro de la propia carpeta de Papyrus.",
					"no_papers_yet": "Aún no hay artículos",
					"none_found": "Ninguno",
					"paper": "Artículo",
					"paper_name": "Nombre del artículo",
					"papers": "Artículos",
					"papyrus": "Papyrus",
					"pdf": "PDF",
					"pdf_missing_status": "Sin compilar",
					"pdf_ready_status": "Listo",
					"rename_config_refused": "No se guardó el nombre: Papyrus no puede cambiar la configuración de este artículo.",
					"rename_paper": "Cambiar el nombre de {{name}}",
					"rename_paper_replaced": "Este artículo cambió desde que se cargó la lista. La lista ya está actualizada; pulsa Intro para guardar el nombre otra vez.",
					"rename_title_rejected": "Escribe un nombre con caracteres visibles o vacía el campo para volver a mostrar {{name}}.",
					"start_a_paper": "Empezar un artículo",
					"start_a_paper_tip": "Crea un artículo vacío desde la plantilla article estándar o clona uno de un remoto de git: sirve cualquiera que tenga un archivo .tex.",
					"verifying_compiler": "Verificando…",
					"your_papers": "Tus artículos"
				},
				"preview": {
					"compile_to_see_the_pdf": "Compila para ver el PDF.",
					"download_pdf": "Descargar el PDF",
					"pdf_preview": "Vista previa del PDF"
				},
				"workspace": {
					"co_author": "Coautor",
					"co_author_conflict": "El coautor cambió este archivo",
					"co_author_conflict_discard": "Descartar mis cambios y recargar",
					"co_author_conflict_discard_button": "Descartar cambios",
					"co_author_conflict_discard_confirm": "Se descartarán tus cambios sin guardar en “{{file}}” y se cargará la versión del coautor. Esta acción no se puede deshacer.",
					"co_author_conflict_discard_title": "¿Descartar los cambios sin guardar?",
					"commit_and_push": "Confirmar y enviar",
					"commit_message_prompt": "Describe esta confirmación. Incluye todos los cambios del artículo.",
					"compile": "Compilar",
					"compiling": "Compilando…",
					"context_not_attached": "Menciona el artículo en tu próximo mensaje para que el coautor pueda verlo. Puedes descartar este aviso una vez que lo hayas mencionado.",
					"context_notice_title": "No se pudo compartir este artículo con el coautor",
					"cursor_position": "Lín. {{line}}, col. {{column}}",
					"delete_file_confirm": "¿Eliminar “{{file}}”?",
					"download_pdf": "Descargar PDF",
					"editing": "Editando {{file}}",
					"editing_unsaved": "Editando {{file}}: sin guardar",
					"error_count_many": "{{count}} errores",
					"error_count_one": "{{count}} error",
					"error_count_other": "{{count}} errores",
					"git_branch": "Rama actual",
					"log": "Registro",
					"main_document": "Documento principal",
					"new_file_prompt": "Nombra el archivo nuevo, por ejemplo methods.tex",
					"papers": "Artículos",
					"pull": "Traer",
					"save_and_compile_hint": "Pulsa Cmd+S (Ctrl+S en Windows y Linux) para guardar y compilar.",
					"session_title": "Papyrus: {{name}}",
					"warning_count_many": "{{count}} advertencias",
					"warning_count_one": "{{count}} advertencia",
					"warning_count_other": "{{count}} advertencias",
					"word_count_many": "{{count}} palabras",
					"word_count_one": "{{count}} palabra",
					"word_count_other": "{{count}} palabras"
				}
			},
			"specBuilder": { "components": { "specDetail": { "resize_document_panel": "Redimensionar el panel del documento" } } }
		},
		components: {
			"confirmDialog": { "cancel": "Cancelar" },
			"resizeHandle": { "drag_to_resize": "Arrastra para redimensionar" }
		},
		lib: { "scriptLabel": {
			"cyrillic": "letra cirílica",
			"greek": "letra griega",
			"latin": "letra latina",
			"other": "carácter"
		} },
		pages: { "chat": {
			"fileBrowserRail": { "resize": "Cambiar tamaño del explorador" },
			"sidePanel": { "resize_panel": "Redimensionar el panel" }
		} }
	},
	fr: {
		apps: {
			"papyrus": {
				"coAuthor": {
					"close_co_author_panel": "Fermer le panneau de coécriture",
					"close_panel": "Fermer le panneau — la session reste ouverte",
					"co_author": "Coauteur",
					"co_author_chat": "Discussion de coécriture",
					"no_co_author_session_for_this_paper_yet": "Aucune session de coécriture pour cet article pour l’instant.",
					"open_in_chat_page": "Ouvrir dans la page de discussion",
					"start_a_session": "Démarrer une session",
					"starting_session": "Démarrage de la session…"
				},
				"diagnostics": {
					"jump_to_line": "Aller à la ligne {{line}}",
					"line_short": "L{{line}}",
					"no_messages": "Le compilateur n’a rien signalé.",
					"typesetting_hints_many": "{{count}} remarques de composition",
					"typesetting_hints_one": "{{count}} remarque de composition",
					"typesetting_hints_other": "{{count}} remarques de composition"
				},
				"fileTree": {
					"delete_file": "Supprimer {{file}}",
					"files": "Fichiers",
					"main": "Principal",
					"new_file": "Nouveau fichier",
					"no_source_files": "Aucun fichier source."
				},
				"manifest": {
					"configuration_1": "Installe la version gérée de Tectonic depuis l'app ou place tectonic ou pdflatex dans PATH, puis crée un article ou clone un dépôt avec des identifiants Git non interactifs déjà configurés.",
					"description": "Un éditeur d’articles LaTeX avec aperçu PDF en direct et un co-auteur doté d’IA. Écris dans un éditeur en deux volets, appuie sur Cmd+S (Ctrl+S sous Windows et Linux) pour compiler avec pdflatex ou tectonic, et lis le PDF rendu à côté de ton source. Les erreurs de compilation sont analysées en une liste cliquable qui saute à la ligne fautive. Clone un article existant depuis n’importe quel dépôt git distant, puis commite et pousse depuis la barre d’outils. Le panneau de co-auteur est une véritable session de chat Kiro Crew limitée à l’article, pour que l’agent puisse lire et modifier ton LaTeX pendant que tu regardes le PDF se mettre à jour.",
					"display_name": "Papyrus",
					"highlight_1": "Éditeur LaTeX en deux volets avec un aperçu PDF en direct à côté",
					"highlight_2": "Compilation à l’enregistrement (Cmd+S, ou Ctrl+S sous Windows et Linux) via pdflatex ou tectonic, avec le cycle bibtex exécuté pour toi",
					"highlight_3": "Pas de TeX installé ? Un clic installe un compilateur Tectonic vérifié dans le dossier propre à Papyrus",
					"highlight_4": "Erreurs et avertissements du compilateur analysés en une liste cliquable qui saute à la ligne",
					"highlight_5": "Chat de co-auteur IA limité à l’article — il lit et modifie le LaTeX que tu as sous les yeux",
					"highlight_6": "Clone un article depuis n’importe quel dépôt git distant, puis commite, récupère et pousse depuis la barre d’outils",
					"highlight_7": "N’exécute jamais le compilateur avec shell escape, donc un fichier .tex hostile ne peut pas exécuter de commandes",
					"page_label": "Papyrus",
					"use_case_1": "Rédige un article LaTeX à côté de son PDF compilé, passe des erreurs de compilation à la source et collabore avec un agent limité à l'article."
				},
				"page": {
					"actions": "Actions",
					"clone": "Cloner",
					"clone_url": "URL du dépôt",
					"clone_url_placeholder": "Cloner depuis une URL git…",
					"cloning": "Clonage…",
					"compiled_count_label": "Compilés",
					"compiler": "Compilateur",
					"compiler_tip": "Le compilateur LaTeX trouvé sur la machine qui exécute {{productName}}. Papyrus privilégie pdflatex et se rabat sur tectonic.",
					"create": "Créer",
					"create_one_above_or_clone_an_existing_repository": "Créez-en un ci-dessus, ou clonez un dépôt existant.",
					"delete_paper": "Supprimer {{name}}",
					"delete_paper_confirm": "Supprimer « {{name}} » et tous ses fichiers ? Cette action est irréversible.",
					"downloading_compiler_progress": "Téléchargement… {{done}} sur {{total}}",
					"install_compiler": "Installer le compilateur",
					"installing_compiler": "Installation…",
					"invalid_project_name": "Les noms d’article servent de noms de dossier. Ils ne peuvent donc contenir que des lettres latines minuscules (a–z), des chiffres (0–9), des points, des traits d’union et des tirets bas, doivent commencer par une lettre ou un chiffre et comporter au plus 64 caractères.",
					"invalid_project_name_char": "« {{char}} » ne peut pas être utilisé dans un nom d’article. Utilise des minuscules a–z, 0–9, .\xA0-⁠\xA0_",
					"invalid_project_name_letter": "« {{char}} » ({{script}}, {{code}}) ne peut pas être utilisé dans un nom d’article. Utilise des minuscules a–z, 0–9, .\xA0-⁠\xA0_",
					"last_edited": "Dernière modification",
					"latex_papers_with_a_live_pdf_preview": "Des articles LaTeX avec un aperçu PDF en direct",
					"new_paper_name": "Nom du nouvel article",
					"new_paper_name_placeholder": "Nommez votre article…",
					"no_compiler_found_install_texlive_or_tectonic": "Aucun compilateur LaTeX n’a été trouvé sur cette machine. Installez TeX Live (pdflatex) ou tectonic pour compiler.",
					"no_compiler_install_bundled_prompt": "Aucun compilateur LaTeX n’a été trouvé sur cette machine. Installez le compilateur Tectonic fourni : un seul téléchargement vérifié, conservé dans le dossier propre à Papyrus.",
					"no_papers_yet": "Aucun article pour l’instant",
					"none_found": "Aucun",
					"paper": "Article",
					"paper_name": "Nom de l'article",
					"papers": "Articles",
					"papyrus": "Papyrus",
					"pdf": "PDF",
					"pdf_missing_status": "Non compilé",
					"pdf_ready_status": "Prêt",
					"rename_config_refused": "Le nom n’a pas été enregistré : Papyrus ne peut pas modifier les paramètres de cet article.",
					"rename_paper": "Renommer {{name}}",
					"rename_paper_replaced": "Cet article a changé depuis le chargement de la liste. La liste est à jour ; appuie sur Entrée pour enregistrer à nouveau le nom.",
					"rename_title_rejected": "Saisis un nom avec des caractères visibles, ou vide le champ pour afficher de nouveau {{name}}.",
					"start_a_paper": "Commencer un article",
					"start_a_paper_tip": "Créez un article vide depuis le modèle article standard, ou clonez-en un depuis un dépôt distant git : tout dépôt contenant un fichier .tex convient.",
					"verifying_compiler": "Vérification…",
					"your_papers": "Vos articles"
				},
				"preview": {
					"compile_to_see_the_pdf": "Compilez pour voir le PDF.",
					"download_pdf": "Télécharger le PDF",
					"pdf_preview": "Aperçu du PDF"
				},
				"workspace": {
					"co_author": "Coauteur",
					"co_author_conflict": "Le co-auteur a modifié ce fichier",
					"co_author_conflict_discard": "Abandonner mes modifications et recharger",
					"co_author_conflict_discard_button": "Abandonner les modifications",
					"co_author_conflict_discard_confirm": "Abandonne vos modifications non enregistrées de « {{file}} » et charge la version du co-auteur. Cette action est irréversible.",
					"co_author_conflict_discard_title": "Abandonner les modifications non enregistrées ?",
					"commit_and_push": "Valider et publier",
					"commit_message_prompt": "Décrivez ce commit. Il inclut toutes les modifications de l’article.",
					"compile": "Compiler",
					"compiling": "Compilation…",
					"context_not_attached": "Mentionne l'article dans ton prochain message pour que le coauteur puisse le voir. Tu peux fermer cet avis une fois la mention faite.",
					"context_notice_title": "Impossible de partager cet article avec le coauteur",
					"cursor_position": "Ligne {{line}}, col. {{column}}",
					"delete_file_confirm": "Supprimer « {{file}} » ?",
					"download_pdf": "Télécharger le PDF",
					"editing": "Modification de {{file}}",
					"editing_unsaved": "Modification de {{file}} — non enregistré",
					"error_count_many": "{{count}} erreurs",
					"error_count_one": "{{count}} erreur",
					"error_count_other": "{{count}} erreurs",
					"git_branch": "Branche actuelle",
					"log": "Journal",
					"main_document": "Document principal",
					"new_file_prompt": "Nommez le nouveau fichier, par exemple methods.tex",
					"papers": "Articles",
					"pull": "Récupérer",
					"save_and_compile_hint": "Appuyez sur Cmd+S (Ctrl+S sous Windows et Linux) pour enregistrer et compiler.",
					"session_title": "Papyrus : {{name}}",
					"warning_count_many": "{{count}} avertissements",
					"warning_count_one": "{{count}} avertissement",
					"warning_count_other": "{{count}} avertissements",
					"word_count_many": "{{count}} mots",
					"word_count_one": "{{count}} mot",
					"word_count_other": "{{count}} mots"
				}
			},
			"specBuilder": { "components": { "specDetail": { "resize_document_panel": "Redimensionner le panneau du document" } } }
		},
		components: {
			"confirmDialog": { "cancel": "Annuler" },
			"resizeHandle": { "drag_to_resize": "Faire glisser pour redimensionner" }
		},
		lib: { "scriptLabel": {
			"cyrillic": "lettre cyrillique",
			"greek": "lettre grecque",
			"latin": "lettre latine",
			"other": "caractère"
		} },
		pages: { "chat": {
			"fileBrowserRail": { "resize": "Redimensionner l'explorateur" },
			"sidePanel": { "resize_panel": "Redimensionner le panneau" }
		} }
	},
	hi: {
		apps: /* @__PURE__ */ JSON.parse("{\"papyrus\":{\"coAuthor\":{\"close_co_author_panel\":\"सह-लेखक पैनल बंद करें\",\"close_panel\":\"पैनल बंद करें — सत्र खुला रहेगा\",\"co_author\":\"सह-लेखक\",\"co_author_chat\":\"सह-लेखक चैट\",\"no_co_author_session_for_this_paper_yet\":\"इस पेपर के लिए अभी कोई सह-लेखक सत्र नहीं है।\",\"open_in_chat_page\":\"चैट पेज में खोलें\",\"start_a_session\":\"सत्र शुरू करें\",\"starting_session\":\"सत्र शुरू हो रहा है…\"},\"diagnostics\":{\"jump_to_line\":\"पंक्ति {{line}} पर जाएँ\",\"line_short\":\"पं. {{line}}\",\"no_messages\":\"कंपाइलर ने कुछ नहीं बताया।\",\"typesetting_hints_one\":\"{{count}} टाइपसेटिंग सुझाव\",\"typesetting_hints_other\":\"{{count}} टाइपसेटिंग सुझाव\"},\"fileTree\":{\"delete_file\":\"{{file}} हटाएँ\",\"files\":\"फ़ाइलें\",\"main\":\"मुख्य\",\"new_file\":\"नई फ़ाइल\",\"no_source_files\":\"कोई स्रोत फ़ाइल नहीं।\"},\"manifest\":{\"configuration_1\":\"ऐप से managed Tectonic इंस्टॉल करें या tectonic अथवा pdflatex को PATH में रखें, फिर पेपर बनाएँ या पहले से कॉन्फ़िगर non-interactive Git credential वाली रिपॉज़िटरी clone करें।\",\"description\":\"लाइव PDF प्रीव्यू और AI सह-लेखक वाला LaTeX पेपर एडिटर। स्प्लिट-पेन एडिटर में लिखो, pdflatex या tectonic से कंपाइल करने के लिए Cmd+S (Windows और Linux पर Ctrl+S) दबाओ, और रेंडर हुई PDF अपने सोर्स के साथ पढ़ो। कंपाइल की गलतियाँ एक क्लिक करने योग्य सूची में बदल जाती हैं जो सीधे गड़बड़ वाली लाइन पर ले जाती है। किसी भी git रिमोट से मौजूदा पेपर क्लोन करो, फिर टूलबार से कमिट और पुश करो। सह-लेखक पैनल पेपर तक सीमित एक असली Kiro Crew चैट सेशन है, इसलिए एजेंट तुम्हारा LaTeX पढ़ और बदल सकता है जबकि तुम PDF अपडेट होते देखते हो।\",\"display_name\":\"Papyrus\",\"highlight_1\":\"साथ में लाइव PDF प्रीव्यू वाला स्प्लिट-पेन LaTeX एडिटर\",\"highlight_2\":\"सेव पर कंपाइल (Cmd+S, या Windows और Linux पर Ctrl+S) pdflatex या tectonic से, और bibtex चक्र तुम्हारे लिए चला दिया जाता है\",\"highlight_3\":\"TeX इंस्टॉल नहीं है? एक क्लिक में जाँचा-परखा Tectonic कंपाइलर Papyrus के अपने फ़ोल्डर में इंस्टॉल हो जाता है\",\"highlight_4\":\"कंपाइलर की गलतियाँ और चेतावनियाँ एक क्लिक करने योग्य सूची में बदलती हैं जो सीधे उस लाइन पर ले जाती है\",\"highlight_5\":\"पेपर तक सीमित AI सह-लेखक चैट — यह वही LaTeX पढ़ता और बदलता है जो तुम देख रहे हो\",\"highlight_6\":\"किसी भी git रिमोट से पेपर क्लोन करो, फिर टूलबार से कमिट, पुल और पुश करो\",\"highlight_7\":\"कंपाइलर को कभी shell escape के साथ नहीं चलाता, इसलिए कोई ख़तरनाक .tex फ़ाइल कमांड नहीं चला सकती\",\"page_label\":\"Papyrus\",\"use_case_1\":\"संकलित PDF के साथ LaTeX पेपर लिखें, build error से सीधे source पर जाएँ और पेपर तक सीमित agent के साथ काम करें।\"},\"page\":{\"actions\":\"कार्रवाइयाँ\",\"clone\":\"क्लोन करें\",\"clone_url\":\"रिपॉज़िटरी URL\",\"clone_url_placeholder\":\"किसी git URL से क्लोन करें…\",\"cloning\":\"क्लोन हो रहा है…\",\"compiled_count_label\":\"कंपाइल हुए\",\"compiler\":\"कंपाइलर\",\"compiler_tip\":\"{{productName}} चलाने वाली मशीन पर मिला LaTeX कंपाइलर। Papyrus पहले pdflatex चुनता है, न मिलने पर tectonic।\",\"create\":\"बनाएँ\",\"create_one_above_or_clone_an_existing_repository\":\"ऊपर एक नया बनाएँ, या कोई मौजूदा रिपॉज़िटरी क्लोन करें।\",\"delete_paper\":\"{{name}} हटाएँ\",\"delete_paper_confirm\":\"“{{name}}” और उसकी सभी फ़ाइलें हटाएँ? इसे पूर्ववत नहीं किया जा सकता।\",\"downloading_compiler_progress\":\"डाउनलोड हो रहा है… {{total}} में से {{done}}\",\"install_compiler\":\"कंपाइलर इंस्टॉल करें\",\"installing_compiler\":\"इंस्टॉल हो रहा है…\",\"invalid_project_name\":\"पेपर का नाम उसके फ़ोल्डर का नाम बनता है, इसलिए उसमें सिर्फ़ छोटे लैटिन अक्षर (a–z), अंक (0–9), बिंदु, हाइफ़न और अंडरस्कोर हो सकते हैं। नाम किसी अक्षर या अंक से शुरू होना चाहिए और उसमें ज़्यादा से ज़्यादा 64 वर्ण हो सकते हैं।\",\"invalid_project_name_char\":\"“{{char}}” पेपर के नाम में इस्तेमाल नहीं किया जा सकता। छोटे अक्षर a–z, 0–9, .\xA0-⁠\xA0_ इस्तेमाल करो।\",\"invalid_project_name_letter\":\"“{{char}}” ({{script}}, {{code}}) पेपर के नाम में इस्तेमाल नहीं किया जा सकता। छोटे अक्षर a–z, 0–9, .\xA0-⁠\xA0_ इस्तेमाल करो।\",\"last_edited\":\"अंतिम संपादन\",\"latex_papers_with_a_live_pdf_preview\":\"लाइव PDF प्रीव्यू के साथ LaTeX पेपर\",\"new_paper_name\":\"नए पेपर का नाम\",\"new_paper_name_placeholder\":\"अपने पेपर को नाम दें…\",\"no_compiler_found_install_texlive_or_tectonic\":\"इस मशीन पर कोई LaTeX कंपाइलर नहीं मिला। कंपाइल करने के लिए TeX Live (pdflatex) या tectonic इंस्टॉल करें।\",\"no_compiler_install_bundled_prompt\":\"इस मशीन पर कोई LaTeX कंपाइलर नहीं मिला। साथ में दिया गया Tectonic कंपाइलर इंस्टॉल करें — एक ही सत्यापित डाउनलोड, जो Papyrus के अपने फ़ोल्डर में ही रहता है।\",\"no_papers_yet\":\"अभी कोई पेपर नहीं\",\"none_found\":\"कोई नहीं\",\"paper\":\"पेपर\",\"paper_name\":\"पेपर का नाम\",\"papers\":\"पेपर\",\"papyrus\":\"Papyrus\",\"pdf\":\"PDF\",\"pdf_missing_status\":\"कंपाइल नहीं हुआ\",\"pdf_ready_status\":\"तैयार\",\"rename_config_refused\":\"नाम सेव नहीं हुआ: Papyrus इस पेपर की सेटिंग्स नहीं बदल सकता।\",\"rename_paper\":\"{{name}} का नाम बदलें\",\"rename_paper_replaced\":\"सूची लोड होने के बाद यह पेपर बदल गया है। सूची अब अपडेट है; नाम फिर से सेव करने के लिए Enter दबाओ।\",\"rename_title_rejected\":\"दिखने वाले अक्षरों के साथ नाम लिखो, या फिर से {{name}} दिखाने के लिए फ़ील्ड खाली करो।\",\"start_a_paper\":\"पेपर शुरू करें\",\"start_a_paper_tip\":\"मानक article टेम्पलेट से खाली पेपर बनाएँ, या किसी git रिमोट से क्लोन करें — .tex फ़ाइल वाला कोई भी रिपॉज़िटरी चलेगा।\",\"verifying_compiler\":\"सत्यापित हो रहा है…\",\"your_papers\":\"तुम्हारे पेपर\"},\"preview\":{\"compile_to_see_the_pdf\":\"PDF देखने के लिए कंपाइल करें।\",\"download_pdf\":\"PDF डाउनलोड करें\",\"pdf_preview\":\"PDF प्रीव्यू\"},\"workspace\":{\"co_author\":\"सह-लेखक\",\"co_author_conflict\":\"सह-लेखक ने यह फ़ाइल बदली\",\"co_author_conflict_discard\":\"मेरे बदलाव छोड़ें और फिर लोड करें\",\"co_author_conflict_discard_button\":\"बदलाव छोड़ें\",\"co_author_conflict_discard_confirm\":\"“{{file}}” में तुम्हारे सहेजे न गए बदलाव छोड़कर सह-लेखक का संस्करण लोड किया जाएगा। इसे पूर्ववत नहीं किया जा सकता।\",\"co_author_conflict_discard_title\":\"सहेजे न गए बदलाव छोड़ें?\",\"commit_and_push\":\"कमिट करें और पुश करें\",\"commit_message_prompt\":\"इस कमिट का वर्णन करें। इसमें पेपर के सभी बदलाव शामिल होंगे।\",\"compile\":\"कंपाइल करें\",\"compiling\":\"कंपाइल हो रहा है…\",\"context_not_attached\":\"अगले संदेश में पेपर का उल्लेख करो ताकि सह-लेखक उसे देख सके। उल्लेख करने के बाद तुम इस सूचना को बंद कर सकते हो।\",\"context_notice_title\":\"यह पेपर सह-लेखक के साथ साझा नहीं हो सका\",\"cursor_position\":\"पं. {{line}}, स्तं. {{column}}\",\"delete_file_confirm\":\"“{{file}}” हटाएँ?\",\"download_pdf\":\"PDF डाउनलोड करें\",\"editing\":\"{{file}} संपादित हो रही है\",\"editing_unsaved\":\"{{file}} संपादित हो रही है — सहेजी नहीं गई\",\"error_count_one\":\"{{count}} त्रुटि\",\"error_count_other\":\"{{count}} त्रुटियाँ\",\"git_branch\":\"वर्तमान ब्रांच\",\"log\":\"लॉग\",\"main_document\":\"मुख्य दस्तावेज़\",\"new_file_prompt\":\"नई फ़ाइल का नाम दें, उदाहरण के लिए methods.tex\",\"papers\":\"पेपर\",\"pull\":\"पुल करें\",\"save_and_compile_hint\":\"सहेजने और कंपाइल करने के लिए Cmd+S (Windows और Linux पर Ctrl+S) दबाएँ।\",\"session_title\":\"Papyrus: {{name}}\",\"warning_count_one\":\"{{count}} चेतावनी\",\"warning_count_other\":\"{{count}} चेतावनियाँ\",\"word_count_one\":\"{{count}} शब्द\",\"word_count_other\":\"{{count}} शब्द\"}},\"specBuilder\":{\"components\":{\"specDetail\":{\"resize_document_panel\":\"दस्तावेज़ पैनल का आकार बदलें\"}}}}"),
		components: {
			"confirmDialog": { "cancel": "रद्द करें" },
			"resizeHandle": { "drag_to_resize": "आकार बदलने के लिए खींचें" }
		},
		lib: { "scriptLabel": {
			"cyrillic": "सिरिलिक अक्षर",
			"greek": "ग्रीक अक्षर",
			"latin": "लैटिन अक्षर",
			"other": "वर्ण"
		} },
		pages: { "chat": {
			"fileBrowserRail": { "resize": "फ़ाइल ब्राउज़र का आकार बदलें" },
			"sidePanel": { "resize_panel": "पैनल का आकार बदलें" }
		} }
	},
	it: {
		apps: {
			"papyrus": {
				"coAuthor": {
					"close_co_author_panel": "Chiudi il pannello di coautoria",
					"close_panel": "Chiudi il pannello — la sessione resta aperta",
					"co_author": "Coautore",
					"co_author_chat": "Chat di coautoria",
					"no_co_author_session_for_this_paper_yet": "Non c’è ancora una sessione di coautoria per questo articolo.",
					"open_in_chat_page": "Apri nella pagina della chat",
					"start_a_session": "Avvia una sessione",
					"starting_session": "Avvio della sessione…"
				},
				"diagnostics": {
					"jump_to_line": "Vai alla riga {{line}}",
					"line_short": "R{{line}}",
					"no_messages": "Il compilatore non ha segnalato nulla.",
					"typesetting_hints_many": "{{count}} note di impaginazione",
					"typesetting_hints_one": "{{count}} nota di impaginazione",
					"typesetting_hints_other": "{{count}} note di impaginazione"
				},
				"fileTree": {
					"delete_file": "Elimina {{file}}",
					"files": "File",
					"main": "Principale",
					"new_file": "Nuovo file",
					"no_source_files": "Nessun file sorgente."
				},
				"manifest": {
					"configuration_1": "Installa Tectonic gestito dall'app o aggiungi tectonic o pdflatex a PATH, quindi crea un articolo o clona un repository con credenziali Git non interattive già configurate.",
					"description": "Un editor per articoli in LaTeX con anteprima PDF dal vivo e un coautore AI. Scrivi in un editor a due riquadri, premi Cmd+S (Ctrl+S su Windows e Linux) per compilare con pdflatex o tectonic e leggi il PDF prodotto accanto al sorgente. Gli errori di compilazione vengono raccolti in un elenco cliccabile che salta alla riga incriminata. Clona un articolo esistente da qualsiasi remoto git, poi fai commit e push dalla barra degli strumenti. Il pannello del coautore è una vera sessione di chat di Kiro Crew limitata all’articolo, così l’agente può leggere e modificare il tuo LaTeX mentre guardi il PDF aggiornarsi.",
					"display_name": "Papyrus",
					"highlight_1": "Editor LaTeX a due riquadri con l’anteprima PDF dal vivo accanto",
					"highlight_2": "Compilazione al salvataggio (Cmd+S, o Ctrl+S su Windows e Linux) con pdflatex o tectonic, e il ciclo bibtex eseguito per te",
					"highlight_3": "Nessun TeX installato? Un clic installa un compilatore Tectonic verificato nella cartella di Papyrus",
					"highlight_4": "Errori e avvisi del compilatore raccolti in un elenco cliccabile che salta alla riga",
					"highlight_5": "Chat con il coautore AI limitata all’articolo — legge e modifica il LaTeX che hai davanti",
					"highlight_6": "Clona un articolo da qualsiasi remoto git, poi fai commit, pull e push dalla barra degli strumenti",
					"highlight_7": "Non esegue mai il compilatore con lo shell escape, così un file .tex ostile non può eseguire comandi",
					"page_label": "Papyrus",
					"use_case_1": "Scrivi un articolo LaTeX accanto al PDF compilato, passa dagli errori di build al sorgente e collabora con un agente limitato all'articolo."
				},
				"page": {
					"actions": "Azioni",
					"clone": "Clona",
					"clone_url": "URL del repository",
					"clone_url_placeholder": "Clona da un URL git…",
					"cloning": "Clonazione…",
					"compiled_count_label": "Compilati",
					"compiler": "Compilatore",
					"compiler_tip": "Il compilatore LaTeX trovato sulla macchina che esegue {{productName}}. Papyrus preferisce pdflatex e in alternativa usa tectonic.",
					"create": "Crea",
					"create_one_above_or_clone_an_existing_repository": "Creane uno qui sopra, oppure clona un repository esistente.",
					"delete_paper": "Elimina {{name}}",
					"delete_paper_confirm": "Eliminare «{{name}}» e tutti i suoi file? Questa azione non può essere annullata.",
					"downloading_compiler_progress": "Download… {{done}} di {{total}}",
					"install_compiler": "Installa compilatore",
					"installing_compiler": "Installazione…",
					"invalid_project_name": "I nomi degli articoli diventano nomi di cartella, quindi possono contenere solo lettere latine minuscole (a–z), cifre (0–9), punti, trattini e trattini bassi, devono iniziare con una lettera o una cifra e avere al massimo 64 caratteri.",
					"invalid_project_name_char": "«{{char}}» non può essere usato nel nome di un articolo. Usa lettere minuscole a–z, 0–9, .\xA0-⁠\xA0_",
					"invalid_project_name_letter": "«{{char}}» ({{script}}, {{code}}) non può essere usato nel nome di un articolo. Usa lettere minuscole a–z, 0–9, .\xA0-⁠\xA0_",
					"last_edited": "Ultima modifica",
					"latex_papers_with_a_live_pdf_preview": "Articoli in LaTeX con anteprima PDF in tempo reale",
					"new_paper_name": "Nome del nuovo articolo",
					"new_paper_name_placeholder": "Dai un nome al tuo articolo…",
					"no_compiler_found_install_texlive_or_tectonic": "Su questa macchina non è stato trovato alcun compilatore LaTeX. Installa TeX Live (pdflatex) o tectonic per compilare.",
					"no_compiler_install_bundled_prompt": "Su questa macchina non è stato trovato alcun compilatore LaTeX. Installa il compilatore Tectonic incluso: un unico download verificato, conservato nella cartella di Papyrus.",
					"no_papers_yet": "Ancora nessun articolo",
					"none_found": "Nessuno",
					"paper": "Articolo",
					"paper_name": "Nome dell'articolo",
					"papers": "Articoli",
					"papyrus": "Papyrus",
					"pdf": "PDF",
					"pdf_missing_status": "Non compilato",
					"pdf_ready_status": "Pronto",
					"rename_config_refused": "Il nome non è stato salvato: Papyrus non può modificare le impostazioni di questo articolo.",
					"rename_paper": "Rinomina {{name}}",
					"rename_paper_replaced": "Questo articolo è cambiato da quando è stato caricato l’elenco. L’elenco ora è aggiornato; premi Invio per salvare di nuovo il nome.",
					"rename_title_rejected": "Scrivi un nome con caratteri visibili, oppure svuota il campo per mostrare di nuovo {{name}}.",
					"start_a_paper": "Inizia un articolo",
					"start_a_paper_tip": "Crea un articolo vuoto dal modello article standard, o clonane uno da un remoto git: va bene qualsiasi repository con un file .tex.",
					"verifying_compiler": "Verifica in corso…",
					"your_papers": "I tuoi articoli"
				},
				"preview": {
					"compile_to_see_the_pdf": "Compila per vedere il PDF.",
					"download_pdf": "Scarica il PDF",
					"pdf_preview": "Anteprima del PDF"
				},
				"workspace": {
					"co_author": "Coautore",
					"co_author_conflict": "Il coautore ha modificato questo file",
					"co_author_conflict_discard": "Scarta le mie modifiche e ricarica",
					"co_author_conflict_discard_button": "Scarta le modifiche",
					"co_author_conflict_discard_confirm": "Verranno scartate le modifiche non salvate a «{{file}}» e verrà caricata la versione del coautore. L’azione non può essere annullata.",
					"co_author_conflict_discard_title": "Scartare le modifiche non salvate?",
					"commit_and_push": "Esegui commit e invia",
					"commit_message_prompt": "Descrivi questo commit. Includerà tutte le modifiche dell’articolo.",
					"compile": "Compila",
					"compiling": "Compilazione…",
					"context_not_attached": "Menziona l'articolo nel prossimo messaggio così il coautore potrà vederlo. Puoi chiudere questo avviso dopo la menzione.",
					"context_notice_title": "Non è stato possibile condividere questo articolo con il coautore",
					"cursor_position": "Riga {{line}}, col. {{column}}",
					"delete_file_confirm": "Eliminare «{{file}}»?",
					"download_pdf": "Scarica PDF",
					"editing": "Modifica di {{file}}",
					"editing_unsaved": "Modifica di {{file}} — non salvato",
					"error_count_many": "{{count}} errori",
					"error_count_one": "{{count}} errore",
					"error_count_other": "{{count}} errori",
					"git_branch": "Ramo corrente",
					"log": "Registro",
					"main_document": "Documento principale",
					"new_file_prompt": "Assegna un nome al nuovo file, per esempio methods.tex",
					"papers": "Articoli",
					"pull": "Recupera",
					"save_and_compile_hint": "Premi Cmd+S (Ctrl+S su Windows e Linux) per salvare e compilare.",
					"session_title": "Papyrus: {{name}}",
					"warning_count_many": "{{count}} avvisi",
					"warning_count_one": "{{count}} avviso",
					"warning_count_other": "{{count}} avvisi",
					"word_count_many": "{{count}} parole",
					"word_count_one": "{{count}} parola",
					"word_count_other": "{{count}} parole"
				}
			},
			"specBuilder": { "components": { "specDetail": { "resize_document_panel": "Ridimensiona il pannello del documento" } } }
		},
		components: {
			"confirmDialog": { "cancel": "Annulla" },
			"resizeHandle": { "drag_to_resize": "Trascina per ridimensionare" }
		},
		lib: { "scriptLabel": {
			"cyrillic": "lettera cirillica",
			"greek": "lettera greca",
			"latin": "lettera latina",
			"other": "carattere"
		} },
		pages: { "chat": {
			"fileBrowserRail": { "resize": "Ridimensiona il browser dei file" },
			"sidePanel": { "resize_panel": "Ridimensiona il pannello" }
		} }
	},
	ja: {
		apps: {
			"papyrus": {
				"coAuthor": {
					"close_co_author_panel": "共著者パネルを閉じる",
					"close_panel": "パネルを閉じます。セッションは開いたままです",
					"co_author": "共著者",
					"co_author_chat": "共著者チャット",
					"no_co_author_session_for_this_paper_yet": "このペーパーの共著者セッションはまだありません。",
					"open_in_chat_page": "チャットページで開く",
					"start_a_session": "セッションを開始",
					"starting_session": "セッション開始中…"
				},
				"diagnostics": {
					"jump_to_line": "{{line}} 行目に移動",
					"line_short": "L{{line}}",
					"no_messages": "コンパイラーが何も報告していません。",
					"typesetting_hints_other": "{{count}} 件の植字ヒント"
				},
				"fileTree": {
					"delete_file": "{{file}} を削除",
					"files": "ファイル",
					"main": "メイン",
					"new_file": "新規ファイル",
					"no_source_files": "ソースファイルがありません。"
				},
				"manifest": {
					"configuration_1": "アプリから管理対象の Tectonic をインストールするか、tectonic または pdflatex を PATH に追加します。その後、論文を作成するか、非対話型の Git 認証情報を事前設定してリポジトリをクローンします。",
					"description": "LaTeX ペーパーエディターで、ライブ PDF プレビューと AI 共著者を備えています。スプリットペインエディターで執筆し、Cmd+S（Windows および Linux では Ctrl+S）を押して pdflatex または tectonic でコンパイルします。ソースの横でレンダリングされた PDF を読みます。コンパイルエラーはクリック可能なリストに解析され、問題のある行にジャンプします。任意の git リモートから既存のペーパーをクローンして、ツールバーからコミットしてプッシュします。共著者パネルは、ペーパーにスコープされた実際の Kiro Crew チャットセッションであるため、エージェントは LaTeX を読み取りして編集でき、PDF が更新されるのを見ることができます。",
					"display_name": "Papyrus",
					"highlight_1": "ライブ PDF プレビュー横のスプリットペイン LaTeX エディター",
					"highlight_2": "保存時にコンパイル（Cmd+S、または Windows および Linux では Ctrl+S）pdflatex または tectonic 経由、bibtex サイクルを実行します",
					"highlight_3": "TeX がインストールされていない場合は、Papyrus 独自のフォルダーに検証済み Tectonic コンパイラーをワンクリックでインストールします",
					"highlight_4": "コンパイラーのエラーと警告は、クリック可能なリストに解析され、その行にジャンプします",
					"highlight_5": "AI 共著者チャット、ペーパーにスコープ。見ている LaTeX を読み取りおよび編集します",
					"highlight_6": "任意の git リモートからペーパーをクローンして、ツールバーからコミット、プル、プッシュします",
					"highlight_7": "シェルエスケープなしでコンパイラーを実行するため、敵対的な .tex ファイルはコマンドを実行できません",
					"page_label": "Papyrus",
					"use_case_1": "コンパイル済み PDF と並べて LaTeX 論文を執筆し、ビルドエラーからソースへ移動し、論文専用エージェントと共同作業します。"
				},
				"page": {
					"actions": "操作",
					"clone": "クローン",
					"clone_url": "リポジトリー URL",
					"clone_url_placeholder": "git URL からクローン…",
					"cloning": "クローン中…",
					"compiled_count_label": "コンパイル済み",
					"compiler": "コンパイラー",
					"compiler_tip": "{{productName}} を実行しているマシンで見つかった LaTeX コンパイラー。Papyrus は pdflatex を優先し、tectonic にフォールバックします。",
					"create": "作成",
					"create_one_above_or_clone_an_existing_repository": "上記を作成するか、既存のリポジトリーをクローンしてください。",
					"delete_paper": "{{name}} を削除",
					"delete_paper_confirm": "「{{name}}」とそのすべてのファイルを削除しますか？これは取り消せません。",
					"downloading_compiler_progress": "ダウンロード中… {{done}} / {{total}}",
					"install_compiler": "コンパイラーをインストール",
					"installing_compiler": "インストール中…",
					"invalid_project_name": "ペーパー名はフォルダー名になるため、使用できるのは小文字のラテン文字（a–z）、数字（0–9）、ピリオド、ハイフン、アンダースコアのみです。先頭は英字か数字にし、64 文字以内にする必要があります。",
					"invalid_project_name_char": "「{{char}}」はペーパー名に使用できません。小文字の a–z、0–9、.\xA0-⁠\xA0_ を使用してください。",
					"invalid_project_name_letter": "「{{char}}」（{{script}}、{{code}}）はペーパー名に使用できません。小文字の a–z、0–9、.\xA0-⁠\xA0_ を使用してください。",
					"last_edited": "最終編集",
					"latex_papers_with_a_live_pdf_preview": "ライブ PDF プレビュー付き LaTeX ペーパー",
					"new_paper_name": "新規ペーパー名",
					"new_paper_name_placeholder": "ペーパーに名前を付けます…",
					"no_compiler_found_install_texlive_or_tectonic": "このマシンで LaTeX コンパイラーが見つかりません。コンパイルするには TeX Live（pdflatex）または tectonic をインストールしてください。",
					"no_compiler_install_bundled_prompt": "このマシンで LaTeX コンパイラーが見つかりません。バンドルされた Tectonic コンパイラーをインストールしてください。Papyrus 独自のフォルダー内に保持される、検証済みの単一ダウンロード。",
					"no_papers_yet": "まだペーパーがありません",
					"none_found": "なし",
					"paper": "ペーパー",
					"paper_name": "ペーパー名",
					"papers": "ペーパー",
					"papyrus": "Papyrus",
					"pdf": "PDF",
					"pdf_missing_status": "コンパイル未実施",
					"pdf_ready_status": "準備完了",
					"rename_config_refused": "名前は保存されませんでした。Papyrus はこのペーパーの設定を変更できません。",
					"rename_paper": "{{name}} の名前を変更",
					"rename_paper_replaced": "一覧を読み込んだ後にこのペーパーが変更されました。一覧は最新の状態になりました。もう一度 Enter キーを押して名前を保存してください。",
					"rename_title_rejected": "表示できる文字で名前を入力するか、欄を空にして {{name}} の表示に戻してください。",
					"start_a_paper": "ペーパーを開始",
					"start_a_paper_tip": "標準記事テンプレートから空のペーパーを作成するか、git リモートからクローンしてください。.tex ファイルがあるものなら何でも動作します。",
					"verifying_compiler": "検証中…",
					"your_papers": "ペーパー"
				},
				"preview": {
					"compile_to_see_the_pdf": "PDF を表示するようコンパイルします。",
					"download_pdf": "PDF をダウンロード",
					"pdf_preview": "PDF プレビュー"
				},
				"workspace": {
					"co_author": "共著者",
					"co_author_conflict": "共著者がこのファイルを変更しました",
					"co_author_conflict_discard": "変更を破棄して再度読み込む",
					"co_author_conflict_discard_button": "変更を破棄",
					"co_author_conflict_discard_confirm": "「{{file}}」への保存されていない変更を破棄して、共著者のバージョンを読み込みます。これは取り消せません。",
					"co_author_conflict_discard_title": "保存されていない変更を破棄しますか？",
					"commit_and_push": "コミット＆プッシュ",
					"commit_message_prompt": "このコミットについて説明してください。ペーパー内のすべての変更をステージングします。",
					"compile": "コンパイル",
					"compiling": "コンパイル中…",
					"context_not_attached": "次のメッセージでペーパーに言及すると、共著者が参照できます。 言及したら、この通知は閉じてかまいません。",
					"context_notice_title": "このペーパーを共著者に共有できませんでした",
					"cursor_position": "行 {{line}}、列 {{column}}",
					"delete_file_confirm": "「{{file}}」を削除しますか？",
					"download_pdf": "PDF をダウンロード",
					"editing": "{{file}} を編集中",
					"editing_unsaved": "{{file}} を編集中 — 未保存",
					"error_count_other": "{{count}} 個のエラー",
					"git_branch": "現在のブランチ",
					"log": "ログ",
					"main_document": "メインドキュメント",
					"new_file_prompt": "新しいファイルに名前を付けてください。例: methods.tex",
					"papers": "論文",
					"pull": "プル",
					"save_and_compile_hint": "Cmd+S (Windows と Linux では Ctrl+S) を押して保存およびコンパイルします。",
					"session_title": "Papyrus: {{name}}",
					"warning_count_other": "{{count}} 個の警告",
					"word_count_other": "{{count}} 個の単語"
				}
			},
			"specBuilder": { "components": { "specDetail": { "resize_document_panel": "ドキュメントパネルのサイズ変更" } } }
		},
		components: {
			"confirmDialog": { "cancel": "キャンセル" },
			"resizeHandle": { "drag_to_resize": "ドラッグしてサイズを変更" }
		},
		lib: { "scriptLabel": {
			"cyrillic": "キリル文字",
			"greek": "ギリシャ文字",
			"latin": "ラテン文字",
			"other": "文字"
		} },
		pages: { "chat": {
			"fileBrowserRail": { "resize": "ファイルブラウザーのサイズを変更" },
			"sidePanel": { "resize_panel": "パネルのサイズを変更" }
		} }
	},
	ko: {
		apps: {
			"papyrus": {
				"coAuthor": {
					"close_co_author_panel": "공동 저자 패널 닫기",
					"close_panel": "패널 닫기 — 세션은 계속 열려 있습니다",
					"co_author": "공동 저자",
					"co_author_chat": "공동 저자 채팅",
					"no_co_author_session_for_this_paper_yet": "이 논문에 대한 공동 저자 세션이 아직 없습니다.",
					"open_in_chat_page": "채팅 페이지에서 열기",
					"start_a_session": "세션 시작",
					"starting_session": "세션 시작 중…"
				},
				"diagnostics": {
					"jump_to_line": "{{line}}행으로 이동",
					"line_short": "L{{line}}",
					"no_messages": "컴파일러가 보고한 내용이 없습니다.",
					"typesetting_hints_other": "조판 힌트 {{count}}건"
				},
				"fileTree": {
					"delete_file": "{{file}} 삭제",
					"files": "파일",
					"main": "메인",
					"new_file": "새 파일",
					"no_source_files": "소스 파일이 없습니다."
				},
				"manifest": {
					"configuration_1": "앱에서 관리형 Tectonic을 설치하거나 tectonic 또는 pdflatex를 PATH에 추가하세요. 그런 다음 논문을 만들거나 비대화형 Git 자격 증명을 미리 구성해 저장소를 클론하세요.",
					"description": "실시간 PDF 미리보기와 AI 공동 저자를 갖춘 LaTeX 논문 에디터입니다. 분할 창 에디터에서 작성하고 Cmd+S(Windows 및 Linux에서는 Ctrl+S)를 눌러 pdflatex 또는 tectonic으로 컴파일하며, 소스 옆에서 렌더링된 PDF를 읽습니다. 컴파일 오류는 문제가 된 행으로 이동하는 클릭 가능한 목록으로 파싱됩니다. 임의의 git 리모트에서 기존 논문을 클론한 뒤 툴바에서 커밋하고 푸시하세요. 공동 저자 패널은 논문에 범위가 지정된 실제 Kiro Crew 채팅 세션이므로, PDF가 갱신되는 것을 보는 동안 에이전트가 LaTeX를 읽고 편집할 수 있습니다.",
					"display_name": "Papyrus",
					"highlight_1": "실시간 PDF 미리보기를 옆에 둔 분할 창 LaTeX 에디터",
					"highlight_2": "저장 시 컴파일(Cmd+S, Windows 및 Linux에서는 Ctrl+S), pdflatex 또는 tectonic 경유, bibtex 주기까지 대신 실행",
					"highlight_3": "TeX가 설치되어 있지 않다면? 한 번의 클릭으로 검증된 Tectonic 컴파일러를 Papyrus 전용 폴더에 설치합니다",
					"highlight_4": "컴파일러 오류와 경고를 해당 행으로 이동하는 클릭 가능한 목록으로 파싱",
					"highlight_5": "논문에 범위가 지정된 AI 공동 저자 채팅 — 보고 있는 LaTeX를 읽고 편집합니다",
					"highlight_6": "임의의 git 리모트에서 논문을 클론한 뒤 툴바에서 커밋, 풀, 푸시",
					"highlight_7": "셸 이스케이프로 컴파일러를 실행하지 않으므로 악의적인 .tex 파일이 명령을 실행할 수 없습니다",
					"page_label": "Papyrus",
					"use_case_1": "컴파일된 PDF 옆에서 LaTeX 논문을 작성하고, 빌드 오류에서 소스로 이동하며, 논문 전용 에이전트와 협업합니다."
				},
				"page": {
					"actions": "작업",
					"clone": "클론",
					"clone_url": "저장소 URL",
					"clone_url_placeholder": "git URL에서 클론…",
					"cloning": "클론 중…",
					"compiled_count_label": "컴파일됨",
					"compiler": "컴파일러",
					"compiler_tip": "{{productName}}을(를) 실행하는 머신에서 발견된 LaTeX 컴파일러입니다. Papyrus는 pdflatex를 우선 사용하고 tectonic으로 대체합니다.",
					"create": "만들기",
					"create_one_above_or_clone_an_existing_repository": "위에서 하나를 만들거나 기존 저장소를 클론하세요.",
					"delete_paper": "{{name}} 삭제",
					"delete_paper_confirm": "‘{{name}}’와(과) 모든 파일을 삭제하시겠습니까? 되돌릴 수 없습니다.",
					"downloading_compiler_progress": "다운로드 중… {{total}} 중 {{done}}",
					"install_compiler": "컴파일러 설치",
					"installing_compiler": "설치 중…",
					"invalid_project_name": "논문 이름은 폴더 이름이 되므로 소문자 라틴 문자(a–z), 숫자(0–9), 마침표, 하이픈, 밑줄만 사용할 수 있습니다. 이름은 문자나 숫자로 시작해야 하며 최대 64자까지 가능합니다.",
					"invalid_project_name_char": "‘{{char}}’은(는) 논문 이름에 사용할 수 없습니다. 소문자 a–z, 0–9, .\xA0-⁠\xA0_ 문자만 사용하세요.",
					"invalid_project_name_letter": "‘{{char}}’({{script}}, {{code}})은(는) 논문 이름에 사용할 수 없습니다. 소문자 a–z, 0–9, .\xA0-⁠\xA0_ 문자만 사용하세요.",
					"last_edited": "마지막 편집",
					"latex_papers_with_a_live_pdf_preview": "실시간 PDF 미리보기가 있는 LaTeX 논문",
					"new_paper_name": "새 논문 이름",
					"new_paper_name_placeholder": "논문 이름을 지정하세요…",
					"no_compiler_found_install_texlive_or_tectonic": "이 머신에서 LaTeX 컴파일러를 찾을 수 없습니다. 컴파일하려면 TeX Live(pdflatex) 또는 tectonic을 설치하세요.",
					"no_compiler_install_bundled_prompt": "이 머신에서 LaTeX 컴파일러를 찾을 수 없습니다. 번들된 Tectonic 컴파일러를 설치하세요 — 검증된 단일 다운로드로, Papyrus 전용 폴더 안에 보관됩니다.",
					"no_papers_yet": "아직 논문 없음",
					"none_found": "없음",
					"paper": "논문",
					"paper_name": "논문 이름",
					"papers": "논문",
					"papyrus": "Papyrus",
					"pdf": "PDF",
					"pdf_missing_status": "컴파일되지 않음",
					"pdf_ready_status": "준비됨",
					"rename_config_refused": "이름이 저장되지 않았습니다. Papyrus가 이 논문의 설정을 변경할 수 없습니다.",
					"rename_paper": "{{name}} 이름 변경",
					"rename_paper_replaced": "목록을 불러온 뒤 이 논문이 변경되었습니다. 목록이 최신 상태로 바뀌었으니 Enter 키를 눌러 이름을 다시 저장하세요.",
					"rename_title_rejected": "보이는 글자로 이름을 입력하거나, 입력란을 비워 {{name}}(으)로 다시 표시하세요.",
					"start_a_paper": "논문 시작",
					"start_a_paper_tip": "표준 article 템플릿으로 빈 논문을 만들거나 git 리모트에서 클론하세요 — .tex 파일이 있으면 무엇이든 동작합니다.",
					"verifying_compiler": "검증 중…",
					"your_papers": "내 논문"
				},
				"preview": {
					"compile_to_see_the_pdf": "PDF를 보려면 컴파일하세요.",
					"download_pdf": "PDF 다운로드",
					"pdf_preview": "PDF 미리보기"
				},
				"workspace": {
					"co_author": "공동 저자",
					"co_author_conflict": "공동 저자가 이 파일을 변경했습니다",
					"co_author_conflict_discard": "내 변경 사항을 버리고 다시 불러오기",
					"co_author_conflict_discard_button": "변경 사항 버리기",
					"co_author_conflict_discard_confirm": "‘{{file}}’에 저장하지 않은 변경 사항을 버리고 공동 저자의 버전을 불러옵니다. 되돌릴 수 없습니다.",
					"co_author_conflict_discard_title": "저장하지 않은 변경 사항을 버리시겠습니까?",
					"commit_and_push": "커밋 & 푸시",
					"commit_message_prompt": "이 커밋을 설명하세요. 논문의 모든 변경 사항을 스테이징합니다.",
					"compile": "컴파일",
					"compiling": "컴파일 중…",
					"context_not_attached": "다음 메시지에서 논문을 언급하면 공동 저자가 볼 수 있습니다. 언급한 뒤에는 이 알림을 닫아도 됩니다.",
					"context_notice_title": "이 논문을 공동 저자와 공유할 수 없었습니다",
					"cursor_position": "{{line}}행, {{column}}열",
					"delete_file_confirm": "‘{{file}}’을(를) 삭제하시겠습니까?",
					"download_pdf": "PDF 다운로드",
					"editing": "{{file}} 편집 중",
					"editing_unsaved": "{{file}} 편집 중 — 저장되지 않음",
					"error_count_other": "오류 {{count}}개",
					"git_branch": "현재 브랜치",
					"log": "로그",
					"main_document": "메인 문서",
					"new_file_prompt": "새 파일 이름을 지정하세요. 예: methods.tex",
					"papers": "논문",
					"pull": "풀",
					"save_and_compile_hint": "Cmd+S(Windows와 Linux에서는 Ctrl+S)를 눌러 저장하고 컴파일하세요.",
					"session_title": "Papyrus: {{name}}",
					"warning_count_other": "경고 {{count}}개",
					"word_count_other": "단어 {{count}}개"
				}
			},
			"specBuilder": { "components": { "specDetail": { "resize_document_panel": "문서 패널 크기 조절" } } }
		},
		components: {
			"confirmDialog": { "cancel": "취소" },
			"resizeHandle": { "drag_to_resize": "끌어서 크기 조절" }
		},
		lib: { "scriptLabel": {
			"cyrillic": "키릴 문자",
			"greek": "그리스 문자",
			"latin": "라틴 문자",
			"other": "문자"
		} },
		pages: { "chat": {
			"fileBrowserRail": { "resize": "파일 브라우저 크기 조절" },
			"sidePanel": { "resize_panel": "패널 크기 조절" }
		} }
	},
	pt: {
		apps: {
			"papyrus": {
				"coAuthor": {
					"close_co_author_panel": "Fechar o painel de coautoria",
					"close_panel": "Fechar o painel — a sessão continua aberta",
					"co_author": "Coautor",
					"co_author_chat": "Conversa de coautoria",
					"no_co_author_session_for_this_paper_yet": "Ainda não há sessão de coautoria para este artigo.",
					"open_in_chat_page": "Abrir na página de conversa",
					"start_a_session": "Iniciar uma sessão",
					"starting_session": "A iniciar a sessão…"
				},
				"diagnostics": {
					"jump_to_line": "Ir para a linha {{line}}",
					"line_short": "L{{line}}",
					"no_messages": "O compilador não relatou nada.",
					"typesetting_hints_many": "{{count}} avisos de composição",
					"typesetting_hints_one": "{{count}} aviso de composição",
					"typesetting_hints_other": "{{count}} avisos de composição"
				},
				"fileTree": {
					"delete_file": "Eliminar {{file}}",
					"files": "Arquivos",
					"main": "Principal",
					"new_file": "Novo arquivo",
					"no_source_files": "Sem arquivos de origem."
				},
				"manifest": {
					"configuration_1": "Instale o Tectonic gerenciado pelo app ou coloque tectonic ou pdflatex no PATH; depois crie um artigo ou clone um repositório com credenciais Git não interativas já configuradas.",
					"description": "Um editor de artigos em LaTeX com pré-visualização de PDF ao vivo e um coautor de IA. Escreva em um editor de painel dividido, pressione Cmd+S (Ctrl+S no Windows e no Linux) para compilar com pdflatex ou tectonic e leia o PDF renderizado ao lado do seu código. Os erros de compilação são convertidos em uma lista clicável que salta para a linha problemática. Clone um artigo existente de qualquer remoto git e faça commit e push pela barra de ferramentas. O painel do coautor é uma sessão de chat real do Kiro Crew delimitada ao artigo, para o agente ler e editar o seu LaTeX enquanto você vê o PDF se atualizar.",
					"display_name": "Papyrus",
					"highlight_1": "Editor LaTeX de painel dividido com uma pré-visualização de PDF ao vivo ao lado",
					"highlight_2": "Compilação ao salvar (Cmd+S ou Ctrl+S no Windows e no Linux) via pdflatex ou tectonic, com o ciclo do bibtex executado para você",
					"highlight_3": "Sem TeX instalado? Um clique instala um compilador Tectonic verificado na pasta do próprio Papyrus",
					"highlight_4": "Erros e avisos do compilador convertidos em uma lista clicável que salta para a linha",
					"highlight_5": "Chat de coautor de IA delimitado ao artigo — ele lê e edita o LaTeX que você está vendo",
					"highlight_6": "Clone um artigo de qualquer remoto git e faça commit, pull e push pela barra de ferramentas",
					"highlight_7": "Nunca executa o compilador com shell escape, então um arquivo .tex hostil não consegue executar comandos",
					"page_label": "Papyrus",
					"use_case_1": "Escreva um artigo em LaTeX ao lado do PDF compilado, vá dos erros de build para o código-fonte e colabore com um agente restrito ao artigo."
				},
				"page": {
					"actions": "Ações",
					"clone": "Clonar",
					"clone_url": "URL do repositório",
					"clone_url_placeholder": "Clonar a partir de um URL git…",
					"cloning": "A clonar…",
					"compiled_count_label": "Compilados",
					"compiler": "Compilador",
					"compiler_tip": "O compilador LaTeX encontrado na máquina que executa o {{productName}}. O Papyrus prefere pdflatex e recorre ao tectonic.",
					"create": "Criar",
					"create_one_above_or_clone_an_existing_repository": "Crie um acima ou clone um repositório existente.",
					"delete_paper": "Eliminar {{name}}",
					"delete_paper_confirm": "Excluir “{{name}}” e todos os seus arquivos? Esta ação não pode ser desfeita.",
					"downloading_compiler_progress": "A baixar… {{done}} de {{total}}",
					"install_compiler": "Instalar compilador",
					"installing_compiler": "A instalar…",
					"invalid_project_name": "Os nomes dos artigos viram nomes de pasta, então só podem conter letras latinas minúsculas (a–z), dígitos (0–9), pontos, hifens e sublinhados, precisam começar com uma letra ou um dígito e ter no máximo 64 caracteres.",
					"invalid_project_name_char": "“{{char}}” não pode ser usado no nome de um artigo. Use letras minúsculas a–z, 0–9, .\xA0-⁠\xA0_",
					"invalid_project_name_letter": "“{{char}}” ({{script}}, {{code}}) não pode ser usado no nome de um artigo. Use letras minúsculas a–z, 0–9, .\xA0-⁠\xA0_",
					"last_edited": "Última edição",
					"latex_papers_with_a_live_pdf_preview": "Artigos em LaTeX com pré-visualização do PDF em tempo real",
					"new_paper_name": "Nome do novo artigo",
					"new_paper_name_placeholder": "Dê um nome ao seu artigo…",
					"no_compiler_found_install_texlive_or_tectonic": "Não foi encontrado nenhum compilador LaTeX nesta máquina. Instale o TeX Live (pdflatex) ou o tectonic para compilar.",
					"no_compiler_install_bundled_prompt": "Não foi encontrado nenhum compilador LaTeX nesta máquina. Instale o compilador Tectonic incluído: um único download verificado, guardado dentro da pasta do próprio Papyrus.",
					"no_papers_yet": "Ainda sem artigos",
					"none_found": "Nenhum",
					"paper": "Artigo",
					"paper_name": "Nome do artigo",
					"papers": "Artigos",
					"papyrus": "Papyrus",
					"pdf": "PDF",
					"pdf_missing_status": "Não compilado",
					"pdf_ready_status": "Pronto",
					"rename_config_refused": "O nome não foi salvo: o Papyrus não consegue alterar as configurações deste artigo.",
					"rename_paper": "Renomear {{name}}",
					"rename_paper_replaced": "Este artigo mudou desde que a lista foi carregada. A lista já está atualizada; pressione Enter para salvar o nome de novo.",
					"rename_title_rejected": "Digite um nome com caracteres visíveis ou esvazie o campo para mostrar {{name}} de novo.",
					"start_a_paper": "Começar um artigo",
					"start_a_paper_tip": "Crie um artigo vazio a partir do modelo article padrão ou clone um de um remoto git — qualquer um com um arquivo .tex serve.",
					"verifying_compiler": "A verificar…",
					"your_papers": "Os seus artigos"
				},
				"preview": {
					"compile_to_see_the_pdf": "Compile para ver o PDF.",
					"download_pdf": "Baixar o PDF",
					"pdf_preview": "Pré-visualização do PDF"
				},
				"workspace": {
					"co_author": "Coautor",
					"co_author_conflict": "O coautor alterou este arquivo",
					"co_author_conflict_discard": "Descartar as minhas alterações e recarregar",
					"co_author_conflict_discard_button": "Descartar alterações",
					"co_author_conflict_discard_confirm": "Serão descartadas as tuas alterações não salvas em “{{file}}” e será carregada a versão do coautor. Não é possível anular esta ação.",
					"co_author_conflict_discard_title": "Descartar alterações não salvas?",
					"commit_and_push": "Confirmar e enviar",
					"commit_message_prompt": "Descreve esta confirmação. Inclui todas as alterações do artigo.",
					"compile": "Compilar",
					"compiling": "A compilar…",
					"context_not_attached": "Mencione o artigo na próxima mensagem para que o coautor possa vê-lo. Você pode fechar este aviso após a menção.",
					"context_notice_title": "Não foi possível compartilhar este artigo com o coautor",
					"cursor_position": "Lin. {{line}}, col. {{column}}",
					"delete_file_confirm": "Eliminar “{{file}}”?",
					"download_pdf": "Baixar PDF",
					"editing": "A editar {{file}}",
					"editing_unsaved": "A editar {{file}} — não guardado",
					"error_count_many": "{{count}} erros",
					"error_count_one": "{{count}} erro",
					"error_count_other": "{{count}} erros",
					"git_branch": "Ramo atual",
					"log": "Registo",
					"main_document": "Documento principal",
					"new_file_prompt": "Dê um nome ao novo arquivo, por exemplo methods.tex",
					"papers": "Artigos",
					"pull": "Obter",
					"save_and_compile_hint": "Prima Cmd+S (Ctrl+S no Windows e Linux) para guardar e compilar.",
					"session_title": "Papyrus: {{name}}",
					"warning_count_many": "{{count}} avisos",
					"warning_count_one": "{{count}} aviso",
					"warning_count_other": "{{count}} avisos",
					"word_count_many": "{{count}} palavras",
					"word_count_one": "{{count}} palavra",
					"word_count_other": "{{count}} palavras"
				}
			},
			"specBuilder": { "components": { "specDetail": { "resize_document_panel": "Redimensionar o painel do documento" } } }
		},
		components: {
			"confirmDialog": { "cancel": "Cancelar" },
			"resizeHandle": { "drag_to_resize": "Arraste para redimensionar" }
		},
		lib: { "scriptLabel": {
			"cyrillic": "letra cirílica",
			"greek": "letra grega",
			"latin": "letra latina",
			"other": "caractere"
		} },
		pages: { "chat": {
			"fileBrowserRail": { "resize": "Redimensionar o navegador de arquivos" },
			"sidePanel": { "resize_panel": "Redimensionar painel" }
		} }
	},
	ru: {
		apps: /* @__PURE__ */ JSON.parse("{\"papyrus\":{\"coAuthor\":{\"close_co_author_panel\":\"Закрыть панель соавтора\",\"close_panel\":\"Закрыть панель — сессия останется открытой\",\"co_author\":\"Соавтор\",\"co_author_chat\":\"Чат с соавтором\",\"no_co_author_session_for_this_paper_yet\":\"Для этой статьи пока нет сессии соавтора.\",\"open_in_chat_page\":\"Открыть на странице чата\",\"start_a_session\":\"Начать сессию\",\"starting_session\":\"Запуск сессии…\"},\"diagnostics\":{\"jump_to_line\":\"Перейти к строке {{line}}\",\"line_short\":\"стр. {{line}}\",\"no_messages\":\"Компилятор ничего не сообщил.\",\"typesetting_hints_few\":\"{{count}} замечания по вёрстке\",\"typesetting_hints_many\":\"{{count}} замечаний по вёрстке\",\"typesetting_hints_one\":\"{{count}} замечание по вёрстке\",\"typesetting_hints_other\":\"{{count}} замечания по вёрстке\"},\"fileTree\":{\"delete_file\":\"Удалить {{file}}\",\"files\":\"Файлы\",\"main\":\"Главный\",\"new_file\":\"Новый файл\",\"no_source_files\":\"Нет исходных файлов.\"},\"manifest\":{\"configuration_1\":\"Установите управляемый Tectonic из приложения либо добавьте tectonic или pdflatex в PATH, затем создайте документ или клонируйте репозиторий с заранее настроенными неинтерактивными учётными данными Git.\",\"description\":\"Редактор статей на LaTeX с живым предпросмотром PDF и соавтором на базе ИИ. Пиши в редакторе с двумя областями, нажимай Cmd+S (Ctrl+S на Windows и Linux), чтобы собрать документ через pdflatex или tectonic, и читай готовый PDF рядом с исходником. Ошибки сборки разбираются в кликабельный список, который переходит к нужной строке. Склонируй готовую статью с любого удалённого репозитория git, а потом делай коммит и push с панели инструментов. Панель соавтора — это настоящая сессия чата Kiro Crew, привязанная к статье, поэтому агент может читать и править твой LaTeX, пока ты смотришь, как обновляется PDF.\",\"display_name\":\"Papyrus\",\"highlight_1\":\"Редактор LaTeX с двумя областями и живым предпросмотром PDF рядом\",\"highlight_2\":\"Сборка при сохранении (Cmd+S или Ctrl+S на Windows и Linux) через pdflatex или tectonic, цикл bibtex прогоняется за тебя\",\"highlight_3\":\"Нет TeX? Один клик — и проверенный компилятор Tectonic ставится в собственную папку Papyrus\",\"highlight_4\":\"Ошибки и предупреждения компилятора разбираются в кликабельный список с переходом к строке\",\"highlight_5\":\"Чат с соавтором на базе ИИ привязан к статье — он читает и правит тот LaTeX, который у тебя на экране\",\"highlight_6\":\"Склонируй статью с любого удалённого репозитория git, а затем делай коммит, pull и push с панели инструментов\",\"highlight_7\":\"Компилятор никогда не запускается с shell escape, поэтому враждебный файл .tex не сможет выполнить команды\",\"page_label\":\"Papyrus\",\"use_case_1\":\"Пишите LaTeX-документ рядом с готовым PDF, переходите от ошибок сборки к исходному коду и работайте с агентом, ограниченным этим документом.\"},\"page\":{\"actions\":\"Действия\",\"clone\":\"Клонировать\",\"clone_url\":\"URL репозитория\",\"clone_url_placeholder\":\"Клонировать по git-адресу…\",\"cloning\":\"Клонирование…\",\"compiled_count_label\":\"Скомпилировано\",\"compiler\":\"Компилятор\",\"compiler_tip\":\"Компилятор LaTeX, найденный на машине с {{productName}}. Papyrus предпочитает pdflatex, а при его отсутствии использует tectonic.\",\"create\":\"Создать\",\"create_one_above_or_clone_an_existing_repository\":\"Создайте статью выше или клонируйте существующий репозиторий.\",\"delete_paper\":\"Удалить {{name}}\",\"delete_paper_confirm\":\"Удалить «{{name}}» и все её файлы? Это действие нельзя отменить.\",\"downloading_compiler_progress\":\"Загрузка… {{done}} из {{total}}\",\"install_compiler\":\"Установить компилятор\",\"installing_compiler\":\"Установка…\",\"invalid_project_name\":\"Названия статей становятся именами папок, поэтому в них можно использовать только строчные латинские буквы (a–z), цифры (0–9), точки, дефисы и подчёркивания. Название должно начинаться с буквы или цифры и содержать не более 64 символов.\",\"invalid_project_name_char\":\"«{{char}}» нельзя использовать в названии статьи. Используй строчные буквы a–z, 0–9, .\xA0-⁠\xA0_\",\"invalid_project_name_letter\":\"«{{char}}» ({{script}}, {{code}}) нельзя использовать в названии статьи. Используй строчные буквы a–z, 0–9, .\xA0-⁠\xA0_\",\"last_edited\":\"Последнее изменение\",\"latex_papers_with_a_live_pdf_preview\":\"Статьи на LaTeX с живым предпросмотром PDF\",\"new_paper_name\":\"Название новой статьи\",\"new_paper_name_placeholder\":\"Назовите статью…\",\"no_compiler_found_install_texlive_or_tectonic\":\"На этой машине не найден компилятор LaTeX. Установите TeX Live (pdflatex) или tectonic, чтобы компилировать.\",\"no_compiler_install_bundled_prompt\":\"На этой машине не найден компилятор LaTeX. Установите входящий в комплект компилятор Tectonic — одна проверенная загрузка, которая остаётся в собственной папке Papyrus.\",\"no_papers_yet\":\"Статей пока нет\",\"none_found\":\"Нет\",\"paper\":\"Статья\",\"paper_name\":\"Название статьи\",\"papers\":\"Статьи\",\"papyrus\":\"Papyrus\",\"pdf\":\"PDF\",\"pdf_missing_status\":\"Не скомпилировано\",\"pdf_ready_status\":\"Готово\",\"rename_config_refused\":\"Название не сохранено: Papyrus не может изменить настройки этой статьи.\",\"rename_paper\":\"Переименовать {{name}}\",\"rename_paper_replaced\":\"Статья изменилась после загрузки списка. Список уже обновлён; нажми Enter, чтобы сохранить название ещё раз.\",\"rename_title_rejected\":\"Введи название с видимыми символами или очисти поле, чтобы снова показывать {{name}}.\",\"start_a_paper\":\"Начать статью\",\"start_a_paper_tip\":\"Создайте пустую статью по стандартному шаблону article или клонируйте её с git-удалённого репозитория — подойдёт любой, где есть файл .tex.\",\"verifying_compiler\":\"Проверка…\",\"your_papers\":\"Ваши статьи\"},\"preview\":{\"compile_to_see_the_pdf\":\"Скомпилируйте, чтобы увидеть PDF.\",\"download_pdf\":\"Скачать PDF\",\"pdf_preview\":\"Предпросмотр PDF\"},\"workspace\":{\"co_author\":\"Соавтор\",\"co_author_conflict\":\"Соавтор изменил этот файл\",\"co_author_conflict_discard\":\"Отбросить мои изменения и перезагрузить\",\"co_author_conflict_discard_button\":\"Отбросить изменения\",\"co_author_conflict_discard_confirm\":\"Отбрасывает несохранённые изменения в «{{file}}» и загружает версию соавтора. Это действие нельзя отменить.\",\"co_author_conflict_discard_title\":\"Отбросить несохранённые изменения?\",\"commit_and_push\":\"Зафиксировать и отправить\",\"commit_message_prompt\":\"Опишите этот коммит. В него войдут все изменения статьи.\",\"compile\":\"Скомпилировать\",\"compiling\":\"Компиляция…\",\"context_not_attached\":\"Упомяни статью в следующем сообщении, чтобы соавтор увидел её. Это уведомление можно закрыть после упоминания.\",\"context_notice_title\":\"Не удалось передать эту статью соавтору\",\"cursor_position\":\"Стр. {{line}}, стлб. {{column}}\",\"delete_file_confirm\":\"Удалить «{{file}}»?\",\"download_pdf\":\"Скачать PDF\",\"editing\":\"Редактируется {{file}}\",\"editing_unsaved\":\"Редактируется {{file}} — не сохранено\",\"error_count_few\":\"{{count}} ошибки\",\"error_count_many\":\"{{count}} ошибок\",\"error_count_one\":\"{{count}} ошибка\",\"error_count_other\":\"{{count}} ошибки\",\"git_branch\":\"Текущая ветка\",\"log\":\"Журнал\",\"main_document\":\"Главный документ\",\"new_file_prompt\":\"Назовите новый файл, например methods.tex\",\"papers\":\"Статьи\",\"pull\":\"Забрать\",\"save_and_compile_hint\":\"Нажмите Cmd+S (Ctrl+S в Windows и Linux), чтобы сохранить и скомпилировать.\",\"session_title\":\"Papyrus: {{name}}\",\"warning_count_few\":\"{{count}} предупреждения\",\"warning_count_many\":\"{{count}} предупреждений\",\"warning_count_one\":\"{{count}} предупреждение\",\"warning_count_other\":\"{{count}} предупреждения\",\"word_count_few\":\"{{count}} слова\",\"word_count_many\":\"{{count}} слов\",\"word_count_one\":\"{{count}} слово\",\"word_count_other\":\"{{count}} слова\"}},\"specBuilder\":{\"components\":{\"specDetail\":{\"resize_document_panel\":\"Изменить размер панели документа\"}}}}"),
		components: {
			"confirmDialog": { "cancel": "Отмена" },
			"resizeHandle": { "drag_to_resize": "Потяните, чтобы изменить размер" }
		},
		lib: { "scriptLabel": {
			"cyrillic": "кириллическая буква",
			"greek": "греческая буква",
			"latin": "латинская буква",
			"other": "символ"
		} },
		pages: { "chat": {
			"fileBrowserRail": { "resize": "Изменить размер обозревателя файлов" },
			"sidePanel": { "resize_panel": "Изменить размер панели" }
		} }
	},
	"zh-CN": {
		apps: {
			"papyrus": {
				"coAuthor": {
					"close_co_author_panel": "关闭合著者面板",
					"close_panel": "关闭面板——会话仍保持打开",
					"co_author": "合著者",
					"co_author_chat": "合著者对话",
					"no_co_author_session_for_this_paper_yet": "这篇论文还没有合著者会话。",
					"open_in_chat_page": "在对话页面中打开",
					"start_a_session": "开始会话",
					"starting_session": "正在启动会话……"
				},
				"diagnostics": {
					"jump_to_line": "跳转到第 {{line}} 行",
					"line_short": "第 {{line}} 行",
					"no_messages": "编译器没有输出任何信息。",
					"typesetting_hints_other": "{{count}} 条排版提示"
				},
				"fileTree": {
					"delete_file": "删除 {{file}}",
					"files": "文件",
					"main": "主文件",
					"new_file": "新建文件",
					"no_source_files": "没有源文件。"
				},
				"manifest": {
					"configuration_1": "在应用中安装托管的 Tectonic，或将 tectonic 或 pdflatex 加入 PATH；然后创建论文或使用已配置的非交互式 Git 凭据克隆仓库。",
					"description": "带实时 PDF 预览和 AI 合著者的 LaTeX 论文编辑器。在分栏编辑器里写作，按 Cmd+S（Windows 和 Linux 上是 Ctrl+S）用 pdflatex 或 tectonic 编译，渲染好的 PDF 就在源码旁边。编译错误会解析成可点击的列表，点一下跳到出错的那一行。可以从任意 git 远端克隆已有论文，然后在工具栏里提交和推送。合著者面板是一个限定在这篇论文范围内的真实 Kiro Crew 会话，代理可以读写你的 LaTeX，你则看着 PDF 实时更新。",
					"display_name": "Papyrus",
					"highlight_1": "分栏 LaTeX 编辑器，旁边是实时 PDF 预览",
					"highlight_2": "保存即编译（Cmd+S，Windows 和 Linux 上为 Ctrl+S），走 pdflatex 或 tectonic，bibtex 的多轮编译也帮你跑完",
					"highlight_3": "没装 TeX？一键把校验过的 Tectonic 编译器装进 Papyrus 自己的文件夹",
					"highlight_4": "编译器的错误和警告会解析成可点击的列表，点一下跳到对应行",
					"highlight_5": "AI 合著者聊天限定在这篇论文范围内 — 它读写你正在看的 LaTeX",
					"highlight_6": "从任意 git 远端克隆论文，然后在工具栏里提交、拉取和推送",
					"highlight_7": "从不带 shell escape 运行编译器，因此恶意 .tex 文件无法执行命令",
					"page_label": "Papyrus",
					"use_case_1": "在编译后的 PDF 旁撰写 LaTeX 论文，从构建错误跳转到源码，并与论文专属代理协作。"
				},
				"page": {
					"actions": "操作",
					"clone": "克隆",
					"clone_url": "仓库地址",
					"clone_url_placeholder": "从 git 地址克隆……",
					"cloning": "正在克隆……",
					"compiled_count_label": "已编译",
					"compiler": "编译器",
					"compiler_tip": "在运行 {{productName}} 的这台机器上找到的 LaTeX 编译器。Papyrus 优先使用 pdflatex，其次使用 tectonic。",
					"create": "创建",
					"create_one_above_or_clone_an_existing_repository": "在上方新建一篇，或克隆一个已有的仓库。",
					"delete_paper": "删除 {{name}}",
					"delete_paper_confirm": "删除“{{name}}”及其所有文件？此操作无法撤销。",
					"downloading_compiler_progress": "正在下载…… {{done}} / {{total}}",
					"install_compiler": "安装编译器",
					"installing_compiler": "正在安装……",
					"invalid_project_name": "论文名称会用作文件夹名称，因此只能包含小写拉丁字母（a–z）、数字（0–9）、点、短横线或下划线，必须以字母或数字开头，且最多 64 个字符。",
					"invalid_project_name_char": "论文名称中不能使用“{{char}}”。只能使用小写 a–z、0–9、.\xA0-⁠\xA0_。",
					"invalid_project_name_letter": "论文名称中不能使用“{{char}}”（{{script}}，{{code}}）。只能使用小写 a–z、0–9、.\xA0-⁠\xA0_。",
					"last_edited": "最后编辑",
					"latex_papers_with_a_live_pdf_preview": "带实时 PDF 预览的 LaTeX 论文",
					"new_paper_name": "新论文名称",
					"new_paper_name_placeholder": "为论文命名……",
					"no_compiler_found_install_texlive_or_tectonic": "在这台机器上没有找到 LaTeX 编译器。请安装 TeX Live（pdflatex）或 tectonic 后再编译。",
					"no_compiler_install_bundled_prompt": "在这台机器上没有找到 LaTeX 编译器。请安装随附 Tectonic 编译器——只需一次经过校验的下载，文件仅保存在 Papyrus 专属文件夹内。",
					"no_papers_yet": "还没有论文",
					"none_found": "无",
					"paper": "论文",
					"paper_name": "论文名称",
					"papers": "论文",
					"papyrus": "Papyrus",
					"pdf": "PDF",
					"pdf_missing_status": "未编译",
					"pdf_ready_status": "已就绪",
					"rename_config_refused": "名称未保存：Papyrus 无法更改这篇论文的设置。",
					"rename_paper": "重命名 {{name}}",
					"rename_paper_replaced": "列表加载后这篇论文已发生变化。列表现已更新；请再次按 Enter 保存名称。",
					"rename_title_rejected": "请输入包含可见字符的名称，或清空输入框以重新显示 {{name}}。",
					"start_a_paper": "开始一篇论文",
					"start_a_paper_tip": "用标准 article 模板新建一篇空白论文，或从 git 远端克隆一篇——只要含有 .tex 文件即可。",
					"verifying_compiler": "正在校验……",
					"your_papers": "你的论文"
				},
				"preview": {
					"compile_to_see_the_pdf": "编译后即可查看 PDF。",
					"download_pdf": "下载 PDF",
					"pdf_preview": "PDF 预览"
				},
				"workspace": {
					"co_author": "合著者",
					"co_author_conflict": "协作者已修改此文件",
					"co_author_conflict_discard": "放弃我的更改并重新加载",
					"co_author_conflict_discard_button": "放弃更改",
					"co_author_conflict_discard_confirm": "将放弃你对“{{file}}”未保存的更改并加载协作者的版本。此操作无法撤销。",
					"co_author_conflict_discard_title": "放弃未保存的更改？",
					"commit_and_push": "提交并推送",
					"commit_message_prompt": "描述此次提交。它将包含论文中的所有更改。",
					"compile": "编译",
					"compiling": "正在编译……",
					"context_not_attached": "请在下一条消息中提及这篇论文，以便合著者可以看到它。 提及后即可关闭此提示。",
					"context_notice_title": "无法将这篇论文共享给合著者",
					"cursor_position": "第 {{line}} 行，第 {{column}} 列",
					"delete_file_confirm": "确定删除“{{file}}”吗？",
					"download_pdf": "下载 PDF",
					"editing": "正在编辑 {{file}}",
					"editing_unsaved": "正在编辑 {{file}}——未保存",
					"error_count_other": "{{count}} 个错误",
					"git_branch": "当前分支",
					"log": "日志",
					"main_document": "主文档",
					"new_file_prompt": "为新文件命名，例如 methods.tex",
					"papers": "论文",
					"pull": "拉取",
					"save_and_compile_hint": "按 Cmd+S（Windows 和 Linux 上为 Ctrl+S）保存并编译。",
					"session_title": "Papyrus：{{name}}",
					"warning_count_other": "{{count}} 个警告",
					"word_count_other": "{{count}} 个词"
				}
			},
			"specBuilder": { "components": { "specDetail": { "resize_document_panel": "调整文档面板大小" } } }
		},
		components: {
			"confirmDialog": { "cancel": "取消" },
			"resizeHandle": { "drag_to_resize": "拖动以调整大小" }
		},
		lib: { "scriptLabel": {
			"cyrillic": "西里尔字母",
			"greek": "希腊字母",
			"latin": "拉丁字母",
			"other": "字符"
		} },
		pages: { "chat": {
			"fileBrowserRail": { "resize": "调整文件浏览器大小" },
			"sidePanel": { "resize_panel": "调整面板大小" }
		} }
	}
};
var own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
function lookup(catalog, key) {
	let node = catalog;
	for (const part of key.split(".")) {
		if (node === void 0 || typeof node === "string" || !own(node, part)) return void 0;
		node = node[part];
	}
	return typeof node === "string" ? node : void 0;
}
/** The catalogs to try for `locale`, most specific first, always ending in English. */
function localeChain(locale) {
	const chain = [];
	const add = (candidate) => {
		if (own(CATALOGS, candidate) && !chain.includes(candidate)) chain.push(candidate);
	};
	add(locale);
	add(locale.split("-")[0]);
	add("en");
	return chain;
}
function currentLocale() {
	try {
		const locale = activeLocale();
		return typeof locale === "string" && locale ? locale : "en";
	} catch {
		return "en";
	}
}
var PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;
function pluralForm(locale, count) {
	try {
		return new Intl.PluralRules(locale).select(count);
	} catch {
		return count === 1 ? "one" : "other";
	}
}
function t(key, vars) {
	const count = vars && typeof vars.count === "number" ? vars.count : void 0;
	for (const locale of localeChain(currentLocale())) {
		const catalog = CATALOGS[locale];
		let text;
		if (count !== void 0) text = lookup(catalog, `${key}_${pluralForm(locale, count)}`) ?? lookup(catalog, `${key}_other`);
		text = text ?? lookup(catalog, key);
		if (text !== void 0) return text.replace(PLACEHOLDER, (whole, name) => vars && own(vars, name) ? String(vars[name]) : whole);
	}
	return key;
}
/** The dashboard's name for this helper, so the ported call sites read unchanged. */
var i18nT = t;
// src/host/useConfirm.tsx
/**
* Promise-based confirm for one component: `confirm(opts)` resolves `true` only
* when the user presses the confirm button; Cancel, Escape, the close button
* and a backdrop click resolve `false`. Render `confirmDialog` once.
*
* The dashboard's own `useConfirm` is private; this is the same contract over
* the host's `Modal` and `Btn` from `@kirocrew/app-sdk/ui`. A second ask while
* one is open answers the first "no", and an unmount answers "no", so no caller
* is left awaiting forever.
*/
function useConfirm() {
	const [pending, setPending] = useState(null);
	const pendingRef = useRef(null);
	const confirm = useCallback((opts) => {
		return new Promise((resolve) => {
			pendingRef.current?.resolve(false);
			const next = {
				opts,
				resolve
			};
			pendingRef.current = next;
			setPending(next);
		});
	}, []);
	const settle = useCallback((confirmed) => {
		pendingRef.current?.resolve(confirmed);
		pendingRef.current = null;
		setPending(null);
	}, []);
	useEffect(() => () => {
		pendingRef.current?.resolve(false);
		pendingRef.current = null;
	}, []);
	const opts = pending?.opts;
	const confirmDialog = opts ? /* @__PURE__ */ jsx(Modal, {
		open: true,
		onClose: () => settle(false),
		title: opts.title,
		maxWidth: 440,
		footer: /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx(Btn, {
			onClick: () => settle(false),
			children: i18nT("components.confirmDialog.cancel")
		}), /* @__PURE__ */ jsx(Btn, {
			danger: !opts.primary && opts.danger !== false,
			primary: opts.primary,
			onClick: () => settle(true),
			children: opts.confirmLabel
		})] }),
		children: opts.body == null ? null : typeof opts.body === "string" ? /* @__PURE__ */ jsx("p", {
			className: "text-sm text-text m-0",
			children: opts.body
		}) : /* @__PURE__ */ jsx("div", {
			className: "text-sm text-text",
			children: opts.body
		})
	}) : null;
	return {
		confirm,
		cancel: useCallback(() => settle(false), [settle]),
		confirmDialog,
		confirmOpen: !!pending
	};
}
// src/host/useIsMobile.ts
/**
* Whether the viewport is phone-narrow (below the dashboard's 768px breakpoint).
*
* The dashboard's own hook is private; this is the same media query read through
* `useSyncExternalStore`, rechecked on resize and orientation changes so a missed
* `change` event cannot strand it.
*/
var MOBILE_QUERY = `(max-width: 767px)`;
function mql() {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
	return window.matchMedia(MOBILE_QUERY);
}
function subscribe(cb) {
	const list = mql();
	list?.addEventListener?.("change", cb);
	window.addEventListener("resize", cb);
	window.addEventListener("orientationchange", cb);
	return () => {
		list?.removeEventListener?.("change", cb);
		window.removeEventListener("resize", cb);
		window.removeEventListener("orientationchange", cb);
	};
}
var getSnapshot = () => mql()?.matches ?? false;
var getServerSnapshot = () => false;
function useIsMobile() {
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
// src/host/NativeSelect.tsx
/**
* The fallback for `Select` on a host that does not export one: a plain native
* `<select>` with the same props, so the call sites do not branch.
*/
function NativeSelect({ options, optionLabels, value, onChange, clearLabel, disabled, "aria-label": ariaLabel, title, className }) {
	const emptyRow = clearLabel !== void 0 || !options.includes(value);
	return /* @__PURE__ */ jsxs("select", {
		value,
		onChange: (e) => onChange(e.target.value),
		disabled,
		"aria-label": ariaLabel,
		title,
		className: "text-sm px-2 py-1 rounded-md bg-[var(--bg-elevated)] border border-[var(--border)] text-[var(--text)]" + (className ? ` ${className}` : ""),
		children: [emptyRow && /* @__PURE__ */ jsx("option", {
			value: "",
			children: clearLabel ?? ""
		}), options.map((option, index) => /* @__PURE__ */ jsx("option", {
			value: option,
			children: optionLabels?.[index] ?? option
		}, option))]
	});
}
var guideCaution = ("guideCaution" in ui ? ui.guideCaution : void 0) ?? {};
/** The host's inline dropdown, or a native `<select>` on a host without one. */
var Select = ("Select" in ui ? ui.Select : void 0) ?? NativeSelect;
// src/host/SearchableSelect.tsx
/**
* The main-document picker. The built-in used the dashboard's private
* `SearchableSelect` (a filterable list); an installed app has the host's
* `Select` from `@kirocrew/app-sdk/ui` (App Kit level 1), or a native
* `<select>` on an older host. Same props as the built-in's call site.
*/
function SearchableSelect({ options, value, onChange, disabled, "aria-label": ariaLabel }) {
	return /* @__PURE__ */ jsx(Select, {
		className: "w-full",
		options: options.map((o) => o.value),
		optionLabels: options.map((o) => o.label),
		value,
		onChange,
		disabled,
		"aria-label": ariaLabel,
		title: ariaLabel
	});
}
var LOAD_SKILL_INSTRUCTION = "Load the `papyrus-writing` skill first — it carries the conduct, the paper-quality principles, the LaTeX house style, and the project path. Then load the task skill that fits the request: `papyrus-make-fluent` (polish as tracked suggestions), `papyrus-latex-comments` / `papyrus-latex-suggestions` (the annotation mechanics), or `papyrus-diagnose-compilation` (a build failure).";
var READ_BEFORE_WRITE_INSTRUCTION = "Read a file before you change it — the author may be editing it in Papyrus at the same time.";
/**
* The context lines handed to the writing assistant on session start.
*
* The agent needs the project name and the main document; the bundled
* `papyrus-writing` skill supplies everything else (where projects live, how to
* compile, the style rules).
*/
function companionContextLines(project, mainFile) {
	return [
		`You are the writing assistant for the Papyrus paper "${project}".`,
		`The main document is ${mainFile || "main.tex"}.`,
		LOAD_SKILL_INSTRUCTION,
		READ_BEFORE_WRITE_INSTRUCTION
	];
}
// src/host/format.ts
/**
* Number, unit and date formatting in the dashboard's active language.
*
* `fmtDateTime` and `compareText` are the host SDK's own. `fmtUnit` and
* `fmtBytes` are not exported by the SDK, so they are restated here over its
* `fmtNumber`, exactly as the dashboard builds them: narrow units, decimal byte
* multiples, and every plain space promoted to a no-break space so a quantity
* never wraps between its number and its unit.
*/
function fmtUnit(value, unit, options) {
	if (!Number.isFinite(value)) return "—";
	return fmtNumber(value, {
		style: "unit",
		unit,
		unitDisplay: "narrow",
		...options
	}).replace(/ /g, "\xA0");
}
function roundToDigits(value, digits) {
	const f = 10 ** digits;
	return Math.round(value * f) / f;
}
function fmtBytes(bytes, options) {
	if (!Number.isFinite(bytes)) return "—";
	const digits = options?.maximumFractionDigits;
	const b = roundToDigits(bytes, digits ?? 0);
	if (Math.abs(b) < 1e3) return fmtUnit(b, "byte", {
		maximumFractionDigits: 0,
		...options
	});
	const kb = roundToDigits(bytes / 1e3, digits ?? 1);
	if (Math.abs(kb) < 1e3) return fmtUnit(kb, "kilobyte", {
		maximumFractionDigits: 1,
		...options
	});
	const mb = roundToDigits(bytes / 1e3 ** 2, digits ?? 1);
	if (Math.abs(mb) < 1e3) return fmtUnit(mb, "megabyte", {
		maximumFractionDigits: 1,
		...options
	});
	const gb = roundToDigits(bytes / 1e3 ** 3, digits ?? 1);
	if (Math.abs(gb) < 1e3) return fmtUnit(gb, "gigabyte", {
		maximumFractionDigits: 1,
		...options
	});
	return fmtUnit(bytes / 1e3 ** 4, "terabyte", {
		maximumFractionDigits: 1,
		...options
	});
}
// src/host/scriptLabel.ts
/**
* Name a single refused letter so it cannot pass for an allowed one.
*
* A Cyrillic or Greek capital renders exactly like the Latin capital a slug rule
* allows, so a message that shows only the glyph shows a character that looks fine.
* The refusal copy therefore puts the letter's script and code point beside it:
* `“О” (Cyrillic letter, U+041E)`.
*
* The script labels are a small catalog-backed set: Latin, Greek and Cyrillic, the
* scripts whose capitals are drawn alike. A letter from any other script is labelled
* a plain "character", and its code point still sets it apart.
*/
var SCRIPT_LABELS = [
	[/^\p{Script=Latin}$/u, () => i18nT("lib.scriptLabel.latin")],
	[/^\p{Script=Greek}$/u, () => i18nT("lib.scriptLabel.greek")],
	[/^\p{Script=Cyrillic}$/u, () => i18nT("lib.scriptLabel.cyrillic")]
];
/** The code point of a single character as Unicode writes it: `U+041E`, `U+1D400`. */
function codePointLabel(char) {
	return `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}
/** The app-language label for the script of one letter, e.g. "Cyrillic letter". */
function scriptLabel(char) {
	for (const [pattern, label] of SCRIPT_LABELS) if (pattern.test(char)) return label();
	return i18nT("lib.scriptLabel.other");
}
/** The interpolation values a `*_letter` refusal key takes beside `char`. */
function refusedLetterParams(char) {
	return {
		char,
		script: scriptLabel(char),
		code: codePointLabel(char)
	};
}
// src/lib.ts
/** localStorage key holding the project the user last had open. */
var LAST_PROJECT_KEY = "kc:papyrus:project";
/** React Query key for the paper list. */
var PROJECTS_QUERY_KEY = ["papyrus", "projects"];
/**
* React Query key for ONE paper's detail.
*
* Shared because the list and the workspace hold SEPARATE cache entries for the
* same paper, and the rename lives in the list while the title it changes is
* rendered by the workspace. Spelling the key out in both files is how they came
* to disagree: invalidating only the list left the renamed paper opening under
* its old name until a reload.
*/
var projectQueryKey = (name) => [
	"papyrus",
	"project",
	name
];
/** localStorage key prefix mapping a project to its co-author chat slot. */
var SLOT_KEY_PREFIX = "kc:papyrus:slot:";
/** File-tree column: persisted width, and the collapsed flag kept apart from it
*  so re-expanding returns the tree to the width the user chose. */
var TREE_WIDTH_KEY = "kc:papyrus:tree-width";
var TREE_COLLAPSED_KEY = "kc:papyrus:tree-collapsed";
/** PDF preview column. Fixed-width with the grip on its LEFT edge, which leaves
*  the source column `flex-1` — so widening the window grows the editor rather
*  than scaling the preview the user just sized. */
var PDF_WIDTH_KEY = "kc:papyrus:pdf-width";
/** The ceiling is a SHARE of the window, not a pixel count.
*
*  Before this column became resizable the source pane was 50% and the preview
*  took the rest, so ANY fixed cap silently removes reach as the window grows: at
*  2560px a 900px cap stops the preview where the old layout gave it 1280, and
*  the surplus lands on an editor that has no grip of its own to give it back —
*  the preview is what the author drags, the editor only absorbs the remainder.
*  Half the window reproduces the old reach at every size, and the same rule cuts
*  the other way on a narrow one: a 1280px window caps the preview at 640 rather
*  than 900, so a drag can no longer crush the editor. */
var PDF_MAX_VIEWPORT_SHARE = .5;
var maxPdfWidth = (viewportWidth) => viewportWidth > 0 ? Math.max(280, Math.round(viewportWidth * PDF_MAX_VIEWPORT_SHARE)) : 900;
/** The starting width, bounded by the ceiling the window allows.
*
*  `loadColumnWidth` returns its fallback UNCHANGED — by design, since an
*  out-of-range stored value says more about stale bounds than about the width
*  the user wants. So the fallback has to arrive already legal: an unbounded 520
*  on a 900px window would render 70px past the 450px ceiling the grip announces
*  and the drag enforces, until the first drag pulled it back into range. */
var defaultPdfWidth = (viewportWidth) => Math.min(maxPdfWidth(viewportWidth), 520);
/** Suffixes hidden from the file tree — LaTeX build artifacts, never editable. */
var ARTIFACT_SUFFIXES = [
	".aux",
	".bbl",
	".blg",
	".fdb_latexmk",
	".fls",
	".log",
	".out",
	".synctex.gz",
	".toc",
	".lof",
	".lot",
	".nav",
	".snm",
	".vrb",
	".pdf"
];
/** True when a path is a build artifact rather than paper source. */
function isArtifact(path) {
	const lower = path.toLowerCase();
	return ARTIFACT_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}
/** Drop build artifacts from a flat file list. */
function sourceFiles(files) {
	return files.filter((f) => !isArtifact(f));
}
/** Only `.tex` files can be the main document. */
function texFiles(files) {
	return files.filter((f) => f.toLowerCase().endsWith(".tex"));
}
/**
* Build a hierarchical tree from a flat list of POSIX relative paths.
* Folders sort before files; both alphabetically within their group, so the
* ordering is stable regardless of the order the backend walked the tree.
*/
function buildTree(paths) {
	const root = /* @__PURE__ */ new Map();
	for (const path of paths) {
		const segments = path.split("/");
		let node = root;
		for (let i = 0; i < segments.length - 1; i++) {
			const segment = segments[i];
			const existing = node.get(segment);
			if (!(existing instanceof Map)) {
				const created = /* @__PURE__ */ new Map();
				node.set(segment, created);
				node = created;
			} else node = existing;
		}
		node.set(segments[segments.length - 1], path);
	}
	function toNodes(entry, parentPath) {
		return [...entry.entries()].sort(([aName, aVal], [bName, bVal]) => {
			const aFolder = aVal instanceof Map;
			if (aFolder !== bVal instanceof Map) return aFolder ? -1 : 1;
			return compareText(aName, bName);
		}).map(([name, value]) => {
			if (typeof value === "string") return {
				name,
				path: value,
				isFolder: false,
				children: []
			};
			const folderPath = parentPath ? `${parentPath}/${name}` : name;
			return {
				name,
				path: folderPath,
				isFolder: true,
				children: toNodes(value, folderPath)
			};
		});
	}
	return toNodes(root, "");
}
function flattenTree(nodes, collapsed, depth = 0) {
	const rows = [];
	for (const node of nodes) {
		rows.push({
			node,
			depth
		});
		if (node.isFolder && !collapsed.has(node.path)) rows.push(...flattenTree(node.children, collapsed, depth + 1));
	}
	return rows;
}
function countDiagnostics(diagnostics) {
	const counts = {
		errors: 0,
		warnings: 0,
		typesetting: 0
	};
	for (const d of diagnostics) if (d.level === "error") counts.errors++;
	else if (d.level === "warning") counts.warnings++;
	else counts.typesetting++;
	return counts;
}
/**
* Word count for a LaTeX document: prose only.
*
* Comments, math, and command tokens are dropped so the number tracks what a
* reader would count rather than the size of the markup. It is an ESTIMATE by
* construction — an exact count needs a TeX parser — but a stable one, which is
* what makes it useful for tracking progress against a page limit.
*
* The precise rule, so the number is predictable rather than mysterious:
*
* - a `%` comment is dropped to end of line, but `\%` is a literal percent sign
*   (extremely common in a results table) and is kept;
* - `$…$`, `$$…$$` and the `equation`/`align`/`gather`/`multline` environments
*   (starred or not) are dropped whole;
* - any remaining whitespace-delimited token starting with `\` is dropped
*   ENTIRELY — so `\section{Introduction}` contributes nothing, heading text
*   included. Splitting the argument out would need brace matching, and a
*   heading is a handful of words against a body of thousands;
* - a token with no letter at all (`---`, `42`, `!!!`) is not a word.
*/
function countWords(source) {
	return source.split("\n").map((line) => line.replace(/(^|[^\\])%.*$/, "$1")).join("\n").replace(/\\begin\{(equation|align|gather|multline)\*?\}[\s\S]*?\\end\{\1\*?\}/g, " ").replace(/\$\$[\s\S]*?\$\$/g, " ").replace(/\$[^$\n]*\$/g, " ").split(/\s+/).filter((token) => token && !token.startsWith("\\") && /[A-Za-zÀ-ɏ]/.test(token)).length;
}
/** Compose the toolbar's one-line git label, e.g. `main*` with ahead/behind counts. */
function gitBranchLabel(status) {
	if (!status?.is_git) return "";
	return `${status.branch || ""}${status.dirty ? "*" : ""}`;
}
/**
* The text to show for a failed create or clone.
*
* A refused paper name answers `invalid_project_name`, with the character that
* stopped it when there was one (a name typed in another script stops at its
* first letter). That is explained in the app's language: the paper name is its
* folder name, so it stays a lowercase Latin slug on purpose, and the server's
* English sentence is only for logs. A refused LETTER is shown with its script
* and code point, because a Cyrillic or Greek capital renders exactly like the
* Latin one the rule allows. Any other failure keeps the server's text.
*/
function projectErrorText(err) {
	if (err instanceof PapyrusApiError && err.code === "invalid_project_name") {
		if (/^\p{L}$/u.test(err.char)) return i18nT("apps.papyrus.page.invalid_project_name_letter", refusedLetterParams(err.char));
		return err.char ? i18nT("apps.papyrus.page.invalid_project_name_char", { char: err.char }) : i18nT("apps.papyrus.page.invalid_project_name");
	}
	return err.message;
}
/**
* The banner text for a refused rename. The server's `error` is English and
* names internals ("settings file"), so each `PUT /title` refusal `code` maps to
* a translated string; anything else (a network failure, an older backend) keeps
* its message.
*/
function renameErrorText(err, name) {
	if (err instanceof PapyrusApiError) switch (err.code) {
		case "title_rejected": return i18nT("apps.papyrus.page.rename_title_rejected", { name });
		case "project_config_refused": return i18nT("apps.papyrus.page.rename_config_refused");
		case "project_replaced": return i18nT("apps.papyrus.page.rename_paper_replaced");
	}
	return err.message;
}
/** Read the last-open project name from localStorage (never throws). */
function loadLastProject() {
	try {
		return localStorage.getItem(LAST_PROJECT_KEY);
	} catch {
		return null;
	}
}
/** Persist (or clear) the last-open project name (never throws). */
function saveLastProject(name) {
	try {
		if (name) localStorage.setItem(LAST_PROJECT_KEY, name);
		else localStorage.removeItem(LAST_PROJECT_KEY);
	} catch {}
}
/**
* Drop remembered slots whose project no longer exists.
*
* Without this the keys accumulate forever, and a project name reused after a
* delete would resurrect the OLD paper's conversation — which reads as the agent
* hallucinating context it was in fact given.
*/
function pruneSlots(liveProjects) {
	try {
		const live = new Set(liveProjects.map((name) => SLOT_KEY_PREFIX + name));
		const stale = [];
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (key && key.startsWith("kc:papyrus:slot:") && !live.has(key)) stale.push(key);
		}
		stale.forEach((key) => localStorage.removeItem(key));
	} catch {}
}
// src/host/columnWidth.ts
/** Read a persisted column width, falling back when the stored value is unusable.
*
* Anything outside [min, max] is discarded rather than clamped: an out-of-range
* value means the number was written under different bounds (a stale value from
* an older min/max, or a hand-edited key), so the caller's default is a better
* guess than the nearest legal width. A blocked or throwing `localStorage` (private
* mode, storage disabled) also falls back rather than propagating. */
function loadColumnWidth(key, min, max, fallback) {
	try {
		const raw = Number(localStorage.getItem(key));
		if (raw >= min && raw <= max) return raw;
	} catch {}
	return fallback;
}
/** Read a persisted "column is collapsed" flag. Stored apart from the width so
* collapsing and re-expanding returns the column to the width the user chose,
* not the default. */
function loadColumnCollapsed(key) {
	try {
		return localStorage.getItem(key) === "1";
	} catch {
		return false;
	}
}
// src/host/safeStorage.ts
function safeSetItem(key, value) {
	try {
		if (typeof localStorage === "undefined") return false;
		localStorage.setItem(key, value);
		return true;
	} catch {
		return false;
	}
}
// src/host/usePointerDrag.ts
/**
* Attach the returned handlers to a drag handle:
*   const drag = usePointerDrag({ onMove: ({ dx }) => setWidth(w0 - dx), threshold: 10 })
*   <div {...drag} />
*/
function usePointerDrag(opts) {
	const st = useRef({
		startX: 0,
		startY: 0,
		lastX: 0,
		lastY: 0,
		active: false,
		committed: false
	});
	const optsRef = useRef(opts);
	optsRef.current = opts;
	const fallback = useRef(null);
	const disarmFallback = useCallback(() => {
		fallback.current?.dispose();
		fallback.current = null;
	}, []);
	const endRef = useRef(() => {});
	const onPointerDown = useCallback((e) => {
		if (e.pointerType === "mouse" && e.button !== 0) return;
		const el = e.currentTarget;
		disarmFallback();
		let captured = true;
		try {
			el.setPointerCapture(e.pointerId);
		} catch {
			captured = false;
		}
		const s = st.current;
		s.startX = e.clientX;
		s.startY = e.clientY;
		s.lastX = e.clientX;
		s.lastY = e.clientY;
		s.active = true;
		s.committed = (optsRef.current.threshold ?? 10) <= 0;
		if (!captured) {
			const pointerId = e.pointerId;
			const onWindowEnd = (ev) => {
				if (ev.pointerId !== pointerId) return;
				endRef.current(ev);
			};
			window.addEventListener("pointerup", onWindowEnd);
			window.addEventListener("pointercancel", onWindowEnd);
			fallback.current = {
				pointerId,
				dispose: () => {
					window.removeEventListener("pointerup", onWindowEnd);
					window.removeEventListener("pointercancel", onWindowEnd);
				}
			};
		}
		optsRef.current.onStart?.(e);
		if (s.committed) optsRef.current.onMove({
			dx: 0,
			dy: 0,
			x: e.clientX,
			y: e.clientY,
			first: true
		});
		e.preventDefault();
	}, [disarmFallback]);
	const onPointerMove = useCallback((e) => {
		const s = st.current;
		if (!s.active) return;
		s.lastX = e.clientX;
		s.lastY = e.clientY;
		const dx = e.clientX - s.startX;
		const dy = e.clientY - s.startY;
		const threshold = optsRef.current.threshold ?? 10;
		if (!s.committed) {
			if (Math.hypot(dx, dy) < threshold) return;
			s.committed = true;
		}
		optsRef.current.onMove({
			dx,
			dy,
			x: e.clientX,
			y: e.clientY,
			first: false
		});
	}, []);
	const end = useCallback((e) => {
		const s = st.current;
		if (!s.active) return;
		s.active = false;
		disarmFallback();
		const target = "currentTarget" in e ? e.currentTarget : null;
		try {
			target?.releasePointerCapture(e.pointerId);
		} catch {}
		if (e.type === "pointerup") {
			s.lastX = e.clientX;
			s.lastY = e.clientY;
		}
		optsRef.current.onEnd?.({
			dx: s.lastX - s.startX,
			dy: s.lastY - s.startY,
			x: s.lastX,
			y: s.lastY,
			first: false,
			committed: s.committed
		});
		s.committed = false;
	}, [disarmFallback]);
	endRef.current = end;
	useEffect(() => disarmFallback, [disarmFallback]);
	return {
		onPointerDown,
		onPointerMove,
		onPointerUp: end,
		onPointerCancel: end,
		onLostPointerCapture: end
	};
}
// src/host/useColumnResize.ts
var DEFAULT_SLOP = 48;
function useColumnResize(storageKey, load, min, max, collapse, loadCollapsed, edge = "right") {
	const sign = edge === "left" ? -1 : 1;
	const [openWidth, setOpenWidth] = useState(load);
	const [collapsed, setCollapsed] = useState(() => !!collapse && !!loadCollapsed?.());
	const [dragging, setDragging] = useState(false);
	const isMobile = useIsMobile();
	const [openedWhileNarrow, setOpenedWhileNarrow] = useState(false);
	const narrowMode = isMobile && !!collapse?.whenNarrow;
	const collapsedEffective = !!collapse && (narrowMode ? !openedWhileNarrow : collapsed);
	const width = collapse && collapsedEffective ? collapse.width : openWidth;
	useEffect(() => {
		if (!narrowMode) setOpenedWhileNarrow(false);
	}, [narrowMode]);
	const startWRef = useRef(0);
	const startCollapsedRef = useRef(false);
	const startOpenRef = useRef(0);
	const draggingRef = useRef(false);
	const liveRef = useRef({
		width,
		collapsed: collapsedEffective,
		openWidth
	});
	liveRef.current = {
		width,
		collapsed: collapsedEffective,
		openWidth
	};
	/** Where the column lands for a drag delta of `dx`, as the OPEN width plus the
	*  collapsed flag. Pure in (dx, drag start), so onMove and onEnd can never
	*  disagree about the result. */
	const resolve = useCallback((dx) => {
		const raw = startWRef.current + dx;
		const clamp = (v) => Math.min(max, Math.max(min, v));
		if (!collapse) return {
			openWidth: clamp(raw),
			collapsed: false
		};
		const slop = collapse.slop ?? DEFAULT_SLOP;
		if (startCollapsedRef.current) {
			const overshoot = raw - (collapse.width + slop);
			return overshoot < 0 ? {
				openWidth: startOpenRef.current,
				collapsed: true
			} : {
				openWidth: clamp(startOpenRef.current + overshoot),
				collapsed: false
			};
		}
		return raw <= min - slop ? {
			openWidth: startOpenRef.current,
			collapsed: true
		} : {
			openWidth: clamp(raw),
			collapsed: false
		};
	}, [
		min,
		max,
		collapse
	]);
	const apply = useCallback((dx) => {
		const next = resolve(dx);
		setOpenWidth(next.openWidth);
		if (narrowMode) setOpenedWhileNarrow(!next.collapsed);
		else setCollapsed(next.collapsed);
		return next;
	}, [resolve, narrowMode]);
	const persist = useCallback((next) => {
		safeSetItem(storageKey, String(next.openWidth));
		if (collapse && !narrowMode) safeSetItem(collapse.storageKey, next.collapsed ? "1" : "0");
	}, [
		storageKey,
		collapse,
		narrowMode
	]);
	const handleProps = usePointerDrag({
		threshold: 0,
		onStart: () => {
			startWRef.current = liveRef.current.width;
			startCollapsedRef.current = liveRef.current.collapsed;
			startOpenRef.current = liveRef.current.openWidth;
			draggingRef.current = true;
			setDragging(true);
			document.body.style.cursor = "col-resize";
			document.body.style.userSelect = "none";
		},
		onMove: ({ dx }) => {
			apply(sign * dx);
		},
		onEnd: ({ dx }) => {
			draggingRef.current = false;
			setDragging(false);
			persist(apply(sign * dx));
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
		}
	});
	useEffect(() => () => {
		if (draggingRef.current) {
			draggingRef.current = false;
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
		}
	}, []);
	const expand = useCallback(() => {
		if (narrowMode) setOpenedWhileNarrow(true);
		else setCollapsed(false);
		persist({
			openWidth: liveRef.current.openWidth,
			collapsed: false
		});
	}, [persist, narrowMode]);
	/** Collapse to the icon strip, keeping the remembered open width.
	*
	*  Symmetric with `expand`, for consumers that need to collapse for a reason
	*  other than a drag — a narrow viewport, where a fixed-width rail beside a
	*  detail pane would leave the pane too narrow to use. Named apart from the
	*  `collapse` CONFIG parameter above, which it reads.  */
	const collapseColumn = useCallback(() => {
		if (!collapse) return;
		if (narrowMode) setOpenedWhileNarrow(false);
		else setCollapsed(true);
		persist({
			openWidth: liveRef.current.openWidth,
			collapsed: true
		});
	}, [
		persist,
		collapse,
		narrowMode
	]);
	return {
		width,
		collapsed: collapsedEffective,
		dragging,
		expand,
		nudge: useCallback((dx) => {
			const d = sign * dx;
			const live = liveRef.current;
			const clamp = (v) => Math.min(max, Math.max(min, v));
			if (collapse && live.collapsed) {
				if (d <= 0) return;
				const next = {
					openWidth: clamp(live.openWidth),
					collapsed: false
				};
				if (narrowMode) setOpenedWhileNarrow(true);
				else setCollapsed(false);
				setOpenWidth(next.openWidth);
				persist(next);
				return;
			}
			const raw = live.openWidth + d;
			const next = collapse && raw < min ? {
				openWidth: live.openWidth,
				collapsed: true
			} : {
				openWidth: clamp(raw),
				collapsed: false
			};
			if (narrowMode) setOpenedWhileNarrow(!next.collapsed);
			else setCollapsed(next.collapsed);
			setOpenWidth(next.openWidth);
			persist(next);
		}, [
			min,
			max,
			collapse,
			persist,
			narrowMode,
			sign
		]),
		collapse: collapseColumn,
		handleProps
	};
}
// src/host/cn.ts
/** Join class names, skipping falsy ones. */
function cn(...parts) {
	return parts.filter(Boolean).join(" ");
}
// src/host/ResizeHandle.tsx
/** Px moved per arrow press, and per Shift+arrow press. */
var STEP = 16;
var COARSE_STEP = 64;
/** The vertical drag grip on a resizable column's edge — one component so the
* Sessions sidebar, the Crew Members roster and the workspace-style surfaces
* (Issue Radar's rail and issue / PR lists, Task Runner's run rail, Projects)
* all look and behave identically, as do Spec Builder's and Code Review Sage's
* column splitters. Pair it with `useColumnResize` (or any `usePointerDrag`)
* for `handleProps`, and `onNudge` for the arrow keys.
*
* Visual contract: a 6px transparent hit strip carrying a 2px `rounded-full`
* bar that stays invisible at rest, turns accent on hover and keyboard focus,
* and accent-hover while dragging. `inset` trims the bar's ends — pass the
* card's corner radius (12px for `rounded-xl`) when the grip runs along a
* rounded card edge so the accent spans exactly the straight segment of the
* border instead of overshooting the rounded corners.
*
* It is the ARIA window-splitter pattern, not a decorative divider: focusable,
* arrow-key operable, and reporting its position. Pointer-only would leave
* keyboard users unable to resize at all — and on a collapsible column, unable
* to reach the layout the mouse can. `value`/`min`/`max` are optional so the
* caller can omit them for a splitter whose extent isn't meaningful, but pass
* them when you have them: without `aria-valuenow` a screen reader announces a
* splitter with no position. */
function ResizeHandle({ handleProps, label, onNudge, value, min, max, inset = 0, className, title }) {
	return /* @__PURE__ */ jsx("div", {
		...handleProps,
		role: "separator",
		"aria-orientation": "vertical",
		"aria-label": label,
		tabIndex: onNudge ? 0 : void 0,
		"aria-valuenow": value,
		"aria-valuemin": min,
		"aria-valuemax": max,
		onKeyDown: onNudge ? (e) => {
			if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
			e.preventDefault();
			const step = e.shiftKey ? COARSE_STEP : STEP;
			onNudge(e.key === "ArrowRight" ? step : -step);
		} : void 0,
		title: title ?? i18nT("components.resizeHandle.drag_to_resize"),
		"data-testid": "resize-handle",
		className: cn("group/drag relative flex w-1.5 shrink-0 items-center justify-center cursor-col-resize select-none focus-ring rounded-full", className),
		style: { touchAction: "none" },
		children: /* @__PURE__ */ jsx("div", {
			"aria-hidden": "true",
			"data-testid": "resize-handle-bar",
			className: "w-[2px] rounded-full bg-transparent transition-colors duration-200 resize-accent group-hover/drag:bg-accent group-focus-visible/drag:bg-accent group-active/drag:bg-accent-hover",
			style: { height: inset > 0 ? `calc(100% - ${inset * 2}px)` : "100%" }
		})
	});
}
// src/ProjectList.tsx
/**
* ProjectList — the Papyrus landing view: create a paper, clone one, or open one.
*
* This is the view that carries the page-layout pattern (`PageHeader` +
* `px-4 md:px-6 pb-8 overflow-y-auto flex-1 min-h-0` container + a `StatCard` row +
* `Card`/`CardTitle` sections), because it is the page-shaped half of the app. The
* editor is a full-bleed split pane by necessity — a paper and its PDF need the
* whole viewport — and it carries its own toolbar instead.
*/
var PROJECTS_KEY = PROJECTS_QUERY_KEY;
var HEALTH_KEY = ["papyrus", "health"];
/** How often /health is re-read while a compiler install is running. */
var HEALTH_POLL_MS = 2e3;
/** Render an epoch-SECONDS timestamp in the APP's language.
*
* `fmtDateTime`, not `toLocaleString`: the paper list sits inside a translated UI,
* so an English date next to translated column headers is the bug this avoids. */
function formatModified(epochSeconds) {
	return fmtDateTime(epochSeconds * 1e3);
}
function ProjectList({ onOpenProject }) {
	const ime = useImeGuard();
	const queryClient = useQueryClient();
	const [newName, setNewName] = useState("");
	const [cloneUrl, setCloneUrl] = useState("");
	const [error, setError] = useState("");
	/** Directory name of the paper whose title is being edited, or '' for none. */
	const [renaming, setRenaming] = useState("");
	const [renameDraft, setRenameDraft] = useState("");
	const [renameSeed, setRenameSeed] = useState("");
	const [renameGeneration, setRenameGeneration] = useState("");
	const [renameRebind, setRenameRebind] = useState(false);
	const projectsQuery = useQuery({
		queryKey: PROJECTS_KEY,
		queryFn: () => papyrusApi.listProjects()
	});
	const healthQuery = useQuery({
		queryKey: HEALTH_KEY,
		queryFn: () => papyrusApi.health(),
		staleTime: 6e4
	});
	const projects = useMemo(() => Array.isArray(projectsQuery.data?.projects) ? projectsQuery.data.projects : [], [projectsQuery.data]);
	const [dismissedListErrorAt, setDismissedListErrorAt] = useState(0);
	const listErrorShown = projectsQuery.isError && projectsQuery.errorUpdatedAt !== dismissedListErrorAt;
	useEffect(() => {
		if (!projectsQuery.data) return;
		pruneSlots(projects.map((p) => p.name));
	}, [projects, projectsQuery.data]);
	const compiledCount = projects.filter((p) => p.has_pdf).length;
	const compiler = healthQuery.data?.compiler ?? "";
	const managed = healthQuery.data?.managed;
	const provisioning = managed?.job.state === "downloading" || managed?.job.state === "verifying" || managed?.job.state === "installing";
	const invalidate = () => queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
	useEffect(() => {
		if (!provisioning) return;
		const timer = setInterval(() => {
			queryClient.invalidateQueries({ queryKey: HEALTH_KEY });
		}, HEALTH_POLL_MS);
		return () => clearInterval(timer);
	}, [provisioning, queryClient]);
	const provisionMutation = useMutation({
		mutationFn: () => papyrusApi.provisionCompiler(),
		onSuccess: () => {
			setError("");
			queryClient.invalidateQueries({ queryKey: HEALTH_KEY });
		},
		onError: (err) => setError(err.message)
	});
	const createMutation = useMutation({
		mutationFn: (name) => papyrusApi.createProject(name),
		onSuccess: async (result) => {
			setNewName("");
			setError("");
			await invalidate();
			onOpenProject(result.name);
		},
		onError: (err) => setError(projectErrorText(err))
	});
	const cloneMutation = useMutation({
		mutationFn: (url) => papyrusApi.cloneProject(url),
		onSuccess: async (result) => {
			setCloneUrl("");
			setError("");
			await invalidate();
			onOpenProject(result.name);
		},
		onError: (err) => setError(projectErrorText(err))
	});
	const deleteMutation = useMutation({
		mutationFn: (name) => papyrusApi.deleteProject(name),
		onSuccess: () => invalidate(),
		onError: (err) => setError(err.message)
	});
	const renameMutation = useMutation({
		mutationFn: ({ name, title, generation }) => papyrusApi.setTitle(name, title, generation),
		onSuccess: (result, { name }) => {
			setError("");
			queryClient.setQueryData(PROJECTS_KEY, (data) => data && Array.isArray(data.projects) ? {
				...data,
				projects: data.projects.map((p) => p.name === name ? {
					...p,
					title: result.title
				} : p)
			} : data);
			invalidate();
			queryClient.invalidateQueries({ queryKey: projectQueryKey(name) });
		},
		onError: (err, { name }) => {
			setError(renameErrorText(err, name));
			if (err instanceof PapyrusApiError && err.code === "project_replaced") setRenameRebind(true);
			invalidate();
		}
	});
	/** Open the editor on a row, seeded with what that row currently displays. */
	const startRename = (project) => {
		const seed = project.title || project.name;
		setRenaming(project.name);
		setRenameDraft(seed);
		setRenameSeed(seed);
		setRenameGeneration(project.generation ?? "");
		setRenameRebind(false);
	};
	/**
	* Abandon the edit. Safe against the blur-commits-the-draft trap: clearing
	* `renaming` UNMOUNTS the field, and neither a browser nor React fires a blur
	* for an element that was removed — so Escape cannot save what it rejected.
	* `PapyrusPaperTitle.test.tsx` pins that as behaviour rather than trusting it.
	*/
	const cancelRename = () => {
		setRenaming("");
		setRenameDraft("");
		setRenameSeed("");
	};
	const commitRename = (name) => {
		if (renameMutation.isPending) return;
		const title = renameDraft.trim();
		if (title === renameSeed.trim()) {
			cancelRename();
			return;
		}
		let generation = renameGeneration;
		if (renameRebind) {
			generation = projects.find((p) => p.name === name)?.generation ?? "";
			setRenameGeneration(generation);
			setRenameRebind(false);
		}
		renameMutation.mutate({
			name,
			title,
			generation
		}, { onSuccess: cancelRename });
	};
	/**
	* Open a paper, unless a rename is still open. Clicking another row blurs the
	* field, which starts the save — and leaving now would unmount this list, so
	* a save that then failed would lose the draft it is meant to keep. The click
	* is discarded; once the field closes on success, the user clicks again.
	*/
	const renameOpen = Boolean(renaming) || renameMutation.isPending;
	const leavingSoon = createMutation.isPending || cloneMutation.isPending;
	useEffect(() => {
		if (renaming && projectsQuery.isSuccess && !projects.some((p) => p.name === renaming)) {
			setRenaming("");
			setRenameDraft("");
			setRenameSeed("");
		}
	}, [
		projects,
		renaming,
		projectsQuery.isSuccess
	]);
	const openProject = (name) => {
		if (renameOpen) return;
		onOpenProject(name);
	};
	const submitCreate = () => {
		const name = newName.trim();
		if (name && !renameOpen) createMutation.mutate(name);
	};
	const submitClone = () => {
		const url = cloneUrl.trim();
		if (url && !renameOpen) cloneMutation.mutate(url);
	};
	return /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx(PageHeader, {
		title: i18nT("apps.papyrus.page.papyrus"),
		subtitle: i18nT("apps.papyrus.page.latex_papers_with_a_live_pdf_preview")
	}), /* @__PURE__ */ jsxs("div", {
		className: "px-4 md:px-6 pb-8 overflow-y-auto flex-1 min-h-0",
		children: [
			/* @__PURE__ */ jsxs("div", {
				className: "grid gap-3.5 grid-cols-[repeat(auto-fit,minmax(150px,1fr))] mb-6",
				children: [
					/* @__PURE__ */ jsx(StatCard, {
						label: i18nT("apps.papyrus.page.papers"),
						value: projectsQuery.isLoading ? void 0 : projects.length,
						accent: true
					}),
					/* @__PURE__ */ jsx(StatCard, {
						label: i18nT("apps.papyrus.page.compiled_count_label"),
						value: projectsQuery.isLoading ? void 0 : compiledCount
					}),
					/* @__PURE__ */ jsx(StatCard, {
						label: i18nT("apps.papyrus.page.compiler"),
						value: healthQuery.isLoading ? void 0 : compiler || i18nT("apps.papyrus.page.none_found"),
						colorClass: compiler ? void 0 : "text-warn",
						title: i18nT("apps.papyrus.page.compiler_tip")
					})
				]
			}),
			!healthQuery.isLoading && !compiler && /* @__PURE__ */ jsxs("div", {
				className: "mb-4 bg-warn/10 border border-warn/20 rounded-lg p-3 flex items-start gap-3 animate-rise",
				children: [
					/* @__PURE__ */ jsx(AlertTriangle, { className: "lucide-inline text-warn shrink-0 mt-0.5" }),
					/* @__PURE__ */ jsxs("div", {
						className: "flex-1 text-[13px] text-text",
						children: [
							managed?.supported ? i18nT("apps.papyrus.page.no_compiler_install_bundled_prompt") : i18nT("apps.papyrus.page.no_compiler_found_install_texlive_or_tectonic"),
							provisioning && /* @__PURE__ */ jsx("div", {
								className: "mt-1 text-muted",
								children: managed?.job.state === "verifying" ? i18nT("apps.papyrus.page.verifying_compiler") : managed && managed.job.bytes_total > 0 ? i18nT("apps.papyrus.page.downloading_compiler_progress", {
									done: fmtBytes(managed.job.bytes_downloaded),
									total: fmtBytes(managed.job.bytes_total)
								}) : i18nT("apps.papyrus.page.installing_compiler")
							}),
							managed?.job.state === "error" && managed.job.error && /* @__PURE__ */ jsx("div", {
								className: "mt-1 text-muted break-words",
								children: managed.job.error
							})
						]
					}),
					managed?.supported && /* @__PURE__ */ jsx(Btn, {
						primary: true,
						className: "shrink-0",
						onClick: () => provisionMutation.mutate(),
						disabled: provisioning || provisionMutation.isPending,
						children: provisioning ? /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx(Loader2, { className: "lucide-inline animate-spin" }), i18nT("apps.papyrus.page.installing_compiler")] }) : /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx(Download, { className: "lucide-inline" }), i18nT("apps.papyrus.page.install_compiler")] })
					})
				]
			}),
			/* @__PURE__ */ jsx(ErrorNotice, {
				className: "mb-4 animate-rise",
				message: error || (listErrorShown ? projectsQuery.error.message : ""),
				onDismiss: () => error ? setError("") : setDismissedListErrorAt(projectsQuery.errorUpdatedAt),
				askAgent: !newName && !cloneUrl && !renaming
			}),
			/* @__PURE__ */ jsxs(Card, { children: [
				/* @__PURE__ */ jsxs(CardTitle, { children: [i18nT("apps.papyrus.page.start_a_paper"), /* @__PURE__ */ jsx(InfoTip, { text: i18nT("apps.papyrus.page.start_a_paper_tip") })] }),
				/* @__PURE__ */ jsxs("div", {
					className: "flex flex-wrap gap-2 mb-3",
					children: [/* @__PURE__ */ jsx(Input, {
						className: "flex-1 min-w-[14rem]",
						"aria-label": i18nT("apps.papyrus.page.new_paper_name"),
						placeholder: i18nT("apps.papyrus.page.new_paper_name_placeholder"),
						value: newName,
						onChange: (e) => setNewName(e.target.value),
						...ime.bindEnter({ onEnter: submitCreate })
					}), /* @__PURE__ */ jsxs(SendBtn, {
						onClick: submitCreate,
						disabled: !newName.trim() || createMutation.isPending || renameOpen,
						children: [createMutation.isPending ? /* @__PURE__ */ jsx(Loader2, { className: "lucide-inline animate-spin motion-reduce:animate-none" }) : /* @__PURE__ */ jsx(FilePlus2, { className: "lucide-inline" }), i18nT("apps.papyrus.page.create")]
					})]
				}),
				/* @__PURE__ */ jsxs("div", {
					className: "flex flex-wrap gap-2",
					children: [/* @__PURE__ */ jsx(Input, {
						className: "flex-1 min-w-[14rem]",
						"aria-label": i18nT("apps.papyrus.page.clone_url"),
						placeholder: i18nT("apps.papyrus.page.clone_url_placeholder"),
						value: cloneUrl,
						onChange: (e) => setCloneUrl(e.target.value),
						...ime.bindEnter({ onEnter: submitClone })
					}), /* @__PURE__ */ jsxs(Btn, {
						onClick: submitClone,
						disabled: !cloneUrl.trim() || cloneMutation.isPending || renameOpen,
						children: [cloneMutation.isPending ? /* @__PURE__ */ jsx(Loader2, { className: "lucide-inline animate-spin motion-reduce:animate-none" }) : /* @__PURE__ */ jsx(GitBranch, { className: "lucide-inline" }), cloneMutation.isPending ? i18nT("apps.papyrus.page.cloning") : i18nT("apps.papyrus.page.clone")]
					})]
				})
			] }),
			/* @__PURE__ */ jsxs(Card, { children: [/* @__PURE__ */ jsx(CardTitle, { children: i18nT("apps.papyrus.page.your_papers") }), projectsQuery.isLoading ? /* @__PURE__ */ jsx(ContentSkeleton, { rows: 3 }) : projects.length === 0 ? /* @__PURE__ */ jsx(EmptyState, {
				icon: /* @__PURE__ */ jsx(ScrollText, { className: "lucide-inline" }),
				title: i18nT("apps.papyrus.page.no_papers_yet"),
				subtitle: i18nT("apps.papyrus.page.create_one_above_or_clone_an_existing_repository")
			}) : /* @__PURE__ */ jsxs("table", {
				className: "w-full border-collapse table-striped",
				children: [/* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { children: [
					/* @__PURE__ */ jsx("th", {
						className: "text-left text-muted text-[12px] uppercase tracking-[.04em] px-2.5 py-2 border-b border-border font-medium",
						children: i18nT("apps.papyrus.page.paper")
					}),
					/* @__PURE__ */ jsx("th", {
						className: "text-left text-muted text-[12px] uppercase tracking-[.04em] px-2.5 py-2 border-b border-border font-medium",
						children: i18nT("apps.papyrus.page.last_edited")
					}),
					/* @__PURE__ */ jsx("th", {
						className: "text-left text-muted text-[12px] uppercase tracking-[.04em] px-2.5 py-2 border-b border-border font-medium",
						children: i18nT("apps.papyrus.page.pdf")
					}),
					/* @__PURE__ */ jsx("th", {
						className: "px-2.5 py-2 border-b border-border",
						children: /* @__PURE__ */ jsx("span", {
							className: "sr-only",
							children: i18nT("apps.papyrus.page.actions")
						})
					})
				] }) }), /* @__PURE__ */ jsx("tbody", { children: projects.map((project) => /* @__PURE__ */ jsxs("tr", { children: [
					/* @__PURE__ */ jsx("td", {
						className: "px-2.5 py-2",
						children: renaming === project.name ? /* @__PURE__ */ jsx(Input, {
							autoFocus: true,
							"aria-label": i18nT("apps.papyrus.page.paper_name"),
							value: renameDraft,
							disabled: renameMutation.isPending,
							placeholder: project.name,
							onChange: (e) => setRenameDraft(e.target.value),
							...ime.bindEnter({
								onEnter: () => commitRename(project.name),
								onEscape: cancelRename,
								onBlur: () => commitRename(project.name)
							})
						}) : /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsxs(Clickable, {
							onClick: () => openProject(project.name),
							className: "inline-flex items-center gap-1.5 text-[13px] text-text-strong font-medium cursor-pointer hover:text-accent focus-ring rounded",
							children: [/* @__PURE__ */ jsx(ScrollText, { className: "lucide-inline shrink-0 opacity-70" }), /* @__PURE__ */ jsx("span", {
								className: "min-w-0 [overflow-wrap:anywhere]",
								children: project.title || project.name
							})]
						}), (project.title || project.name) !== project.name && /* @__PURE__ */ jsx("div", {
							className: "text-[12px] text-muted [overflow-wrap:anywhere]",
							children: project.name
						})] })
					}),
					/* @__PURE__ */ jsx("td", {
						className: "px-2.5 py-2 text-[12px] text-muted",
						children: formatModified(project.modified)
					}),
					/* @__PURE__ */ jsx("td", {
						className: "px-2.5 py-2",
						children: project.has_pdf ? /* @__PURE__ */ jsxs("span", {
							className: "inline-flex items-center gap-1 text-[12px] text-ok",
							children: [/* @__PURE__ */ jsx(FileCheck2, { className: "lucide-inline" }), i18nT("apps.papyrus.page.pdf_ready_status")]
						}) : /* @__PURE__ */ jsx("span", {
							className: "text-[12px] text-muted",
							children: i18nT("apps.papyrus.page.pdf_missing_status")
						})
					}),
					/* @__PURE__ */ jsxs("td", {
						className: "px-2.5 py-2 text-right",
						children: [/* @__PURE__ */ jsx("button", {
							type: "button",
							"aria-label": i18nT("apps.papyrus.page.rename_paper", { name: project.title || project.name }),
							title: i18nT("apps.papyrus.page.rename_paper", { name: project.title || project.name }),
							onClick: () => startRename(project),
							disabled: renameOpen || leavingSoon,
							className: "p-1 rounded text-muted hover:text-accent hover:bg-accent/10 cursor-pointer bg-transparent border-none transition-colors disabled:opacity-40",
							children: /* @__PURE__ */ jsx(Pencil, { className: "lucide-inline" })
						}), /* @__PURE__ */ jsx("button", {
							type: "button",
							"aria-label": i18nT("apps.papyrus.page.delete_paper", { name: project.name }),
							...guideCaution,
							title: i18nT("apps.papyrus.page.delete_paper", { name: project.name }),
							onClick: () => {
								if (window.confirm(i18nT("apps.papyrus.page.delete_paper_confirm", { name: project.name }))) deleteMutation.mutate(project.name);
							},
							disabled: deleteMutation.isPending || renameOpen,
							className: "p-1 rounded text-muted hover:text-danger-text hover:bg-danger/10 cursor-pointer bg-transparent border-none transition-colors disabled:opacity-40",
							children: /* @__PURE__ */ jsx(Trash2, { className: "lucide-inline" })
						})]
					})
				] }, project.name)) })]
			})] })
		]
	})] });
}
// src/FileTree.tsx
/**
* FileTree — the project's source files, as a collapsible tree.
*
* Build artifacts (`.aux`, `.log`, `.pdf`, …) are filtered out: they are never
* editable and they bury the two or three files a writer actually opens. The tree
* shape is computed by the pure `buildTree`/`flattenTree` helpers in `lib.ts`, so
* ordering and collapse behaviour are testable without rendering.
*
* Every row is a `<Clickable>` rather than a bare clickable div, so the tree is fully
* keyboard-navigable, and the delete affordance is a labelled icon button rather
* than the upstream app's right-click-to-delete — a context menu is invisible to
* a keyboard user and undiscoverable to everyone else.
*/
/** Lucide glyph for a file, by extension. Never an emoji (see AUTOSDE `no-emoji-as-icons`). */
function FileGlyph({ name }) {
	const lower = name.toLowerCase();
	if (lower.endsWith(".bib")) return /* @__PURE__ */ jsx(Library, { className: "lucide-inline shrink-0 opacity-70" });
	if (lower.endsWith(".sty") || lower.endsWith(".cls")) return /* @__PURE__ */ jsx(Settings2, { className: "lucide-inline shrink-0 opacity-70" });
	if (/\.(png|jpe?g|gif|svg|webp|eps)$/.test(lower)) return /* @__PURE__ */ jsx(Image, { className: "lucide-inline shrink-0 opacity-70" });
	return /* @__PURE__ */ jsx(FileText, { className: "lucide-inline shrink-0 opacity-70" });
}
function FileTree({ files, currentFile, mainFile, onOpenFile, onCreateFile, onDeleteFile }) {
	const [collapsed, setCollapsed] = useState(() => /* @__PURE__ */ new Set());
	const visible = useMemo(() => sourceFiles(files), [files]);
	const tree = useMemo(() => buildTree(visible), [visible]);
	const rows = useMemo(() => flattenTree(tree, collapsed), [tree, collapsed]);
	const toggle = (path) => setCollapsed((prev) => {
		const next = new Set(prev);
		if (next.has(path)) next.delete(path);
		else next.add(path);
		return next;
	});
	const renderRow = (node, depth) => {
		const indent = { paddingLeft: `${.5 + depth * .85}rem` };
		if (node.isFolder) {
			const isCollapsed = collapsed.has(node.path);
			return /* @__PURE__ */ jsxs(Clickable, {
				style: indent,
				onClick: () => toggle(node.path),
				title: node.path,
				"aria-expanded": !isCollapsed,
				className: "flex items-center gap-1 py-1 pr-2 text-[12px] text-muted hover:bg-bg-hover cursor-pointer select-none focus-ring",
				children: [
					isCollapsed ? /* @__PURE__ */ jsx(ChevronRight, { className: "lucide-inline shrink-0" }) : /* @__PURE__ */ jsx(ChevronDown, { className: "lucide-inline shrink-0" }),
					/* @__PURE__ */ jsx(Folder, { className: "lucide-inline shrink-0 opacity-70" }),
					/* @__PURE__ */ jsx("span", {
						className: "truncate",
						children: node.name
					})
				]
			}, `d:${node.path}`);
		}
		const isOpen = node.path === currentFile;
		const isMain = node.path === mainFile;
		return /* @__PURE__ */ jsxs("div", {
			className: `group flex items-center gap-1 pr-1 ${isOpen ? "bg-bg-hover" : "hover:bg-bg-hover"}`,
			children: [/* @__PURE__ */ jsxs(Clickable, {
				style: indent,
				onClick: () => onOpenFile(node.path),
				title: node.path,
				"aria-current": isOpen ? "true" : void 0,
				className: `flex-1 min-w-0 flex items-center gap-1 py-1 text-[12px] cursor-pointer focus-ring ${isOpen ? "text-text-strong font-medium" : "text-text"}`,
				children: [
					/* @__PURE__ */ jsx(FileGlyph, { name: node.name }),
					/* @__PURE__ */ jsx("span", {
						className: "truncate",
						children: node.name
					}),
					isMain && /* @__PURE__ */ jsx("span", {
						className: "ml-1 shrink-0 text-[10px] uppercase tracking-[.04em] text-accent",
						children: i18nT("apps.papyrus.fileTree.main")
					})
				]
			}), !isMain && /* @__PURE__ */ jsx("button", {
				type: "button",
				"aria-label": i18nT("apps.papyrus.fileTree.delete_file", { file: node.name }),
				...guideCaution,
				title: i18nT("apps.papyrus.fileTree.delete_file", { file: node.name }),
				onClick: () => onDeleteFile(node.path),
				className: "p-1 rounded text-muted opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 focus-visible:opacity-100 hover:text-danger-text hover:bg-danger/10 cursor-pointer bg-transparent border-none transition-colors",
				children: /* @__PURE__ */ jsx(Trash2, { className: "lucide-inline" })
			})]
		}, `f:${node.path}`);
	};
	const isMobile = useIsMobile();
	return /* @__PURE__ */ jsxs("div", {
		className: "h-full min-h-0 flex flex-col border-r border-border bg-bg-accent",
		"data-testid": "papyrus-file-tree",
		children: [/* @__PURE__ */ jsxs("div", {
			className: "flex items-center gap-1 px-2 py-1.5 border-b border-border shrink-0",
			children: [
				/* @__PURE__ */ jsx("span", {
					className: `flex-1 text-[12px] font-medium text-muted uppercase tracking-[.04em] ${isMobile ? "sr-only" : ""}`,
					children: i18nT("apps.papyrus.fileTree.files")
				}),
				isMobile && /* @__PURE__ */ jsx("span", { className: "flex-1" }),
				/* @__PURE__ */ jsx("button", {
					type: "button",
					"aria-label": i18nT("apps.papyrus.fileTree.new_file"),
					title: i18nT("apps.papyrus.fileTree.new_file"),
					onClick: onCreateFile,
					className: "p-1 rounded text-muted hover:text-text hover:bg-bg-hover cursor-pointer bg-transparent border-none transition-colors",
					children: /* @__PURE__ */ jsx(Plus, { className: "lucide-inline" })
				})
			]
		}), /* @__PURE__ */ jsx("div", {
			className: "flex-1 min-h-0 overflow-y-auto py-1",
			children: rows.length === 0 ? /* @__PURE__ */ jsx("div", {
				className: "px-2 py-3 text-[12px] text-muted",
				children: i18nT("apps.papyrus.fileTree.no_source_files")
			}) : rows.map(({ node, depth }) => renderRow(node, depth))
		})]
	});
}
// src/PapyrusEditor.tsx
/**
* PapyrusEditor — the LaTeX source pane.
*
* The built-in mounted the dashboard's private Pierre editor. An installed app
* cannot import it, and the App SDK exposes no code editor, so this is a plain
* `<textarea>` with a line-number gutter: no syntax colouring, everything else
* the page relies on kept. The component owns no document state: the page holds
* the buffer and passes it down, and edits come back through `onChange`. It
* exposes `jumpToLine` (a click on a compiler error moves the caret there) and
* `focus`. A diagnostic marks its line in the gutter, coloured by severity, with
* the message as the tooltip. Cmd/Ctrl+S calls `onSave`; Tab inserts two spaces
* instead of leaving the field.
*
* Long lines wrap, as prose does. A gutter number sits at the top of its line,
* and each gutter row is as tall as its line is on screen: a hidden mirror with
* the textarea's width, font and wrapping lays the lines out once more so their
* heights can be measured. Where nothing can be measured (no layout, as under
* jsdom), every row is one line tall.
*/
var LINE_HEIGHT_PX = 20;
var INDENT = "  ";
function severityOf(d) {
	return d.level === "error" ? "error" : d.level === "warning" ? "warning" : "info";
}
var RANK = {
	error: 3,
	warning: 2,
	info: 1
};
var MARK_CLASS = {
	error: "bg-danger/20 text-danger-text",
	warning: "bg-warn/20 text-warn",
	info: "bg-accent/15 text-accent"
};
/** Caret offset -> 1-based (line, column). */
function caretPosition(text, offset) {
	let line = 1;
	let lineStart = 0;
	for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) {
		line += 1;
		lineStart = i + 1;
	}
	return [line, offset - lineStart + 1];
}
/** 1-based line -> caret offset of its first character (clamped to the text). */
function lineOffset(text, line) {
	let remaining = Math.max(1, Math.floor(line)) - 1;
	let i = 0;
	while (remaining > 0) {
		const next = text.indexOf("\n", i);
		if (next < 0) return text.length;
		i = next + 1;
		remaining -= 1;
	}
	return i;
}
var PapyrusEditor = forwardRef(function PapyrusEditor({ path, value, onChange, onSave, diagnostics, onCursorChange, readOnly = false }, ref) {
	const areaRef = useRef(null);
	const gutterRef = useRef(null);
	const mirrorRef = useRef(null);
	const [heights, setHeights] = useState([]);
	const heightsRef = useRef([]);
	const lines = useMemo(() => value.split("\n"), [value]);
	const measure = useCallback(() => {
		const area = areaRef.current;
		const mirror = mirrorRef.current;
		if (!area || !mirror) return;
		mirror.style.width = `${area.clientWidth}px`;
		const next = Array.from(mirror.children, (child) => child.offsetHeight);
		const prev = heightsRef.current;
		if (next.length === prev.length && next.every((h, i) => h === prev[i])) return;
		heightsRef.current = next;
		setHeights(next);
	}, []);
	useLayoutEffect(() => {
		measure();
	}, [lines, measure]);
	useLayoutEffect(() => {
		const area = areaRef.current;
		if (!area || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => measure());
		observer.observe(area);
		return () => observer.disconnect();
	}, [measure]);
	useImperativeHandle(ref, () => ({
		jumpToLine: (line) => {
			const area = areaRef.current;
			if (!area) return;
			const offset = lineOffset(area.value, line);
			area.focus();
			area.setSelectionRange(offset, offset);
			const target = Math.max(1, Math.floor(line)) - 1;
			let top = 0;
			for (let i = 0; i < target; i++) top += heightsRef.current[i] || LINE_HEIGHT_PX;
			area.scrollTop = Math.max(0, top - 60);
			onCursorChange?.(...caretPosition(area.value, offset));
		},
		focus: () => areaRef.current?.focus()
	}), [onCursorChange]);
	const marks = useMemo(() => {
		const byLine = /* @__PURE__ */ new Map();
		for (const d of diagnostics) {
			if (d.line === null || d.line < 1) continue;
			const severity = severityOf(d);
			const entry = byLine.get(d.line);
			if (!entry) byLine.set(d.line, {
				severity,
				messages: [d.message]
			});
			else {
				entry.messages.push(d.message);
				if (RANK[severity] > RANK[entry.severity]) entry.severity = severity;
			}
		}
		return byLine;
	}, [diagnostics]);
	const lineCount = lines.length;
	const reportCursor = useCallback(() => {
		const area = areaRef.current;
		if (area && onCursorChange) onCursorChange(...caretPosition(area.value, area.selectionStart));
	}, [onCursorChange]);
	const onKeyDown = useCallback((event) => {
		if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s") {
			event.preventDefault();
			onSave();
			return;
		}
		if (event.key === "Tab" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
			if (readOnly) return;
			event.preventDefault();
			const area = event.currentTarget;
			const { selectionStart, selectionEnd } = area;
			onChange(area.value.slice(0, selectionStart) + INDENT + area.value.slice(selectionEnd));
			const caret = selectionStart + 2;
			requestAnimationFrame(() => areaRef.current?.setSelectionRange(caret, caret));
		}
	}, [
		onSave,
		onChange,
		readOnly
	]);
	const syncGutter = useCallback(() => {
		if (gutterRef.current && areaRef.current) gutterRef.current.scrollTop = areaRef.current.scrollTop;
	}, []);
	const gutter = useMemo(() => {
		const rows = [];
		for (let line = 1; line <= lineCount; line++) {
			const mark = marks.get(line);
			rows.push(/* @__PURE__ */ jsx("div", {
				className: `pr-2 pl-1 text-right tabular-nums ${mark ? MARK_CLASS[mark.severity] : ""}`,
				style: { height: heights[line - 1] || LINE_HEIGHT_PX },
				title: mark ? mark.messages.join("\n") : void 0,
				"data-marker": mark ? mark.severity : void 0,
				children: line
			}, line));
		}
		return rows;
	}, [
		lineCount,
		marks,
		heights
	]);
	return /* @__PURE__ */ jsxs("div", {
		className: "h-full w-full min-h-0 flex overflow-hidden bg-bg font-mono text-[13px]",
		"data-testid": "papyrus-editor",
		children: [/* @__PURE__ */ jsx("div", {
			ref: gutterRef,
			"aria-hidden": "true",
			className: "shrink-0 overflow-hidden select-none text-muted border-r border-border py-2",
			style: {
				lineHeight: `${LINE_HEIGHT_PX}px`,
				minWidth: "3.25rem"
			},
			children: gutter
		}), /* @__PURE__ */ jsxs("div", {
			className: "relative flex-1 min-w-0 h-full",
			children: [/* @__PURE__ */ jsx("div", {
				ref: mirrorRef,
				"aria-hidden": "true",
				className: "absolute top-0 left-0 invisible pointer-events-none px-3 whitespace-pre-wrap [overflow-wrap:anywhere]",
				style: {
					lineHeight: `${LINE_HEIGHT_PX}px`,
					tabSize: 2,
					boxSizing: "border-box"
				},
				children: lines.map((text, i) => /* @__PURE__ */ jsx("div", { children: text || "​" }, i))
			}), /* @__PURE__ */ jsx("textarea", {
				ref: areaRef,
				value,
				readOnly,
				spellCheck: false,
				autoCapitalize: "off",
				autoComplete: "off",
				autoCorrect: "off",
				wrap: "soft",
				"aria-label": path,
				onChange: (e) => onChange(e.target.value),
				onKeyDown,
				onKeyUp: reportCursor,
				onClick: reportCursor,
				onSelect: reportCursor,
				onScroll: syncGutter,
				className: `relative block w-full h-full resize-none border-0 outline-none bg-transparent text-text px-3 py-2 whitespace-pre-wrap [overflow-wrap:anywhere] overflow-x-hidden overflow-y-auto ${readOnly ? "opacity-60" : ""}`,
				style: {
					lineHeight: `${LINE_HEIGHT_PX}px`,
					tabSize: 2
				}
			}, path)]
		})]
	});
});
// src/PdfPreview.tsx
/**
* PdfPreview — the rendered-PDF pane.
*
* Uses the BROWSER's own PDF viewer (in an `<iframe>`; see below) rather than
* bundling a JS renderer. That is a deliberate dependency decision: the upstream
* app shipped `pdfjs-dist` plus a hand-written text layer and its stylesheet
* (~1 MB of JS and a worker chunk) to reproduce something Chrome, Firefox, Safari
* and Edge all do natively — including text selection, find-in-page, zoom, page
* thumbnails, rotate and print. This repository has no PDF renderer today, and
* adding one to reimplement a built-in viewer is not a trade worth making.
*
* The backend serves the PDF with `Content-Disposition: inline` and a restrictive
* per-response CSP (`sandbox; default-src 'none'`), so the document — which is
* content the agent or a cloned repository produced — cannot script the
* dashboard's origin. That per-response header is the containment; it does not
* depend on which element embeds the document.
*
* `<iframe>`, NOT `<object>`: the dashboard's own base CSP sets `object-src
* 'none'`, so Chromium and Firefox refused to load the plugin document and the
* pane rendered the "cannot display a PDF inline" fallback on the app's headline
* feature. (It went unnoticed because WebKit does not enforce the directive for
* this case, so it worked in Safari.) `frame-src 'self'` already permits a
* same-origin frame, so this needs no CSP widening — the previous justification
* for `<object>` cited an `onError` handler that was never actually wired up, so
* nothing is lost: a browser with no PDF viewer still gets the download link
* below the frame rather than as replaced content.
*
* A keyed remount on `src` is what makes a recompile visible: the same-URL
* document would otherwise be served from the in-page cache, which is why the URL
* carries a version counter.
*/
function PdfPreview({ src, downloadName }) {
	if (!src) return /* @__PURE__ */ jsxs("div", {
		className: "flex-1 min-h-0 flex flex-col items-center justify-center gap-2 text-muted",
		"data-testid": "papyrus-pdf-empty",
		children: [/* @__PURE__ */ jsx(FileWarning, { className: "lucide-inline opacity-50" }), /* @__PURE__ */ jsx("div", {
			className: "text-[13px]",
			children: i18nT("apps.papyrus.preview.compile_to_see_the_pdf")
		})]
	});
	return /* @__PURE__ */ jsxs("div", {
		className: "flex-1 min-h-0 flex flex-col bg-bg-accent",
		"data-testid": "papyrus-pdf",
		children: [/* @__PURE__ */ jsx("iframe", {
			src,
			className: "flex-1 min-h-0 w-full border-0",
			title: i18nT("apps.papyrus.preview.pdf_preview")
		}, src), /* @__PURE__ */ jsx("div", {
			className: "flex items-center justify-center px-3 py-1.5 border-t border-border text-[12px]",
			children: /* @__PURE__ */ jsxs("a", {
				href: src,
				download: downloadName,
				className: "inline-flex items-center gap-1.5 text-accent hover:underline",
				children: [/* @__PURE__ */ jsx(FileDown, { className: "lucide-inline" }), i18nT("apps.papyrus.preview.download_pdf")]
			})
		})]
	});
}
// src/DiagnosticsList.tsx
/**
* DiagnosticsList — parsed compiler errors and warnings, each clickable.
*
* The whole point of parsing the compiler log server-side is this list: clicking a
* row moves the editor's cursor to the offending line, which is the difference
* between "somewhere in a 900-line log" and "here". Rows with no line number are
* still shown (the message is often self-explanatory) but are not interactive, so
* a keyboard user is never handed a control that does nothing.
*
* Typesetting hints (over/underfull boxes) are collapsed behind a toggle: a paper
* near its page limit produces dozens of them and they are never fatal.
*/
function LevelGlyph({ level }) {
	if (level === "error") return /* @__PURE__ */ jsx(XCircle, { className: "lucide-inline shrink-0 text-danger" });
	if (level === "warning") return /* @__PURE__ */ jsx(AlertTriangle, { className: "lucide-inline shrink-0 text-warn" });
	return /* @__PURE__ */ jsx(Ruler, { className: "lucide-inline shrink-0 text-muted" });
}
function DiagnosticRow({ diagnostic, onJumpToLine }) {
	const line = diagnostic.line;
	const messageId = useId();
	const label = line !== null ? i18nT("apps.papyrus.diagnostics.jump_to_line", { line }) : void 0;
	const body = /* @__PURE__ */ jsxs(Fragment, { children: [
		/* @__PURE__ */ jsx(LevelGlyph, { level: diagnostic.level }),
		line !== null && /* @__PURE__ */ jsx("span", {
			className: "shrink-0 font-mono text-[12px] text-muted",
			children: i18nT("apps.papyrus.diagnostics.line_short", { line })
		}),
		/* @__PURE__ */ jsx("span", {
			id: messageId,
			className: "min-w-0 flex-1 text-[13px] break-words",
			children: diagnostic.message
		}),
		diagnostic.file && /* @__PURE__ */ jsx("span", {
			className: "shrink-0 font-mono text-[12px] text-muted truncate max-w-[12rem]",
			children: diagnostic.file
		})
	] });
	if (line === null) return /* @__PURE__ */ jsx("div", {
		className: "flex items-start gap-2 px-2 py-1 rounded",
		children: body
	});
	return /* @__PURE__ */ jsx(Clickable, {
		onClick: () => onJumpToLine(line),
		"aria-label": label,
		"aria-describedby": messageId,
		title: label,
		className: "flex items-start gap-2 px-2 py-1 rounded cursor-pointer hover:bg-bg-hover focus-ring",
		children: body
	});
}
function DiagnosticsList({ diagnostics, log, onJumpToLine }) {
	const [showHints, setShowHints] = useState(false);
	const counts = useMemo(() => countDiagnostics(diagnostics), [diagnostics]);
	const problems = useMemo(() => diagnostics.filter((d) => d.level === "error" || d.level === "warning"), [diagnostics]);
	const hints = useMemo(() => diagnostics.filter((d) => d.level === "typesetting"), [diagnostics]);
	if (diagnostics.length === 0) return /* @__PURE__ */ jsx("div", {
		className: "p-2",
		"data-testid": "papyrus-diagnostics",
		children: log ? /* @__PURE__ */ jsx("pre", {
			className: "max-h-40 overflow-auto rounded bg-bg-accent p-2 font-mono text-[12px] text-muted whitespace-pre-wrap",
			children: log
		}) : /* @__PURE__ */ jsx("div", {
			className: "px-2 py-1 text-[13px] text-muted",
			children: i18nT("apps.papyrus.diagnostics.no_messages")
		})
	});
	return /* @__PURE__ */ jsxs("div", {
		className: "p-1 space-y-0.5 overflow-y-auto",
		"data-testid": "papyrus-diagnostics",
		children: [problems.map((d, i) => /* @__PURE__ */ jsx(DiagnosticRow, {
			diagnostic: d,
			onJumpToLine
		}, `p${i}`)), hints.length > 0 && /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsxs(Clickable, {
			onClick: () => setShowHints((v) => !v),
			"aria-expanded": showHints,
			className: "flex items-center gap-1 px-2 py-1 rounded cursor-pointer text-[12px] text-muted hover:bg-bg-hover focus-ring",
			children: [showHints ? /* @__PURE__ */ jsx(ChevronDown, { className: "lucide-inline shrink-0" }) : /* @__PURE__ */ jsx(ChevronRight, { className: "lucide-inline shrink-0" }), i18nT("apps.papyrus.diagnostics.typesetting_hints", { count: counts.typesetting })]
		}), showHints && hints.map((d, i) => /* @__PURE__ */ jsx(DiagnosticRow, {
			diagnostic: d,
			onJumpToLine
		}, `h${i}`))] })]
	});
}
// src/PapyrusPage.tsx
/**
* PapyrusPage — the Papyrus app's page.
*
* Two views behind one route:
*
* - **No paper open** → `ProjectList`, which follows the standard page layout
*   (`PageHeader` + `px-4 md:px-6 pb-8` container + `StatCard` row + `Card` sections).
* - **A paper open** → a split-pane workspace: file tree, source pane and
*   diagnostics on the left; the rendered PDF on the right. The **Co-author**
*   button saves the paper and opens a new chat in Sessions primed with the
*   paper's name and main document (see `openCoAuthor`). A paper and its PDF
*   need the full viewport, so the editor is deliberately full-bleed and carries
*   its own toolbar.
*
* All server state is React Query (`use-react-query`); the ONLY local state is the
* editor buffer and which pane is showing, because a buffer is genuinely local
* until saved.
*
* Save-and-compile is one action, bound to Cmd/Ctrl+S: the compiler reads the file
* off disk, so compiling an unsaved buffer would silently typeset the previous
* revision. That is why `saveAndCompile` awaits the save before it compiles.
*/
var loadTreeWidth = () => loadColumnWidth(TREE_WIDTH_KEY, 120, 420, 176);
var loadTreeCollapsed = () => loadColumnCollapsed(TREE_COLLAPSED_KEY);
var subscribeViewportWidth = (onChange) => {
	window.addEventListener("resize", onChange);
	window.addEventListener("orientationchange", onChange);
	return () => {
		window.removeEventListener("resize", onChange);
		window.removeEventListener("orientationchange", onChange);
	};
};
var readViewportWidth = () => typeof window === "undefined" ? 0 : window.innerWidth;
var readServerViewportWidth = () => 0;
var loadPdfWidth = () => {
	const viewport = readViewportWidth();
	return loadColumnWidth(PDF_WIDTH_KEY, 280, maxPdfWidth(viewport), defaultPdfWidth(viewport));
};
/** The tree collapses to a strip carrying only its expand button.
*
* `whenNarrow` is deliberately NOT set: on a phone the tree is not a column at
* all — it is a top disclosure bar reserving no horizontal space — so there is
* no squeeze for a strip to relieve, and the strip would add a second, competing
* affordance beside the bar. */
var TREE_COLLAPSE = {
	width: 28,
	storageKey: TREE_COLLAPSED_KEY
};
var MS_PER_SECOND = 1e3;
/** Compile time, readable and localized.
*
* Was a catalog string `"{{ms}} ms"`, which had two defects: a bibliography build
* rendered as `48231 ms` (arithmetic the reader should not have to do), and the
* number skipped `Intl` entirely, so no locale got its own grouping — de expects
* `48.231`, bn expects Bengali digits. `fmtUnit` supplies BOTH the localized
* number and the localized unit, which is why the key is deleted rather than
* reworded: keeping it would weld a hardcoded `ms` onto an already-localized
* number, the exact shape `i18n/unitLiterals.test.ts` exists to catch.
*/
function compileDurationLabel(ms) {
	return ms < MS_PER_SECOND ? fmtUnit(ms, "millisecond", { maximumFractionDigits: 0 }) : fmtUnit(ms / MS_PER_SECOND, "second", { maximumFractionDigits: 1 });
}
/**
* Rejection reason when a mutation aborts because the buffer could not be saved.
*
* Deliberately NOT a catalog key: `saveMutation.onError` has already put the real
* write failure on screen, so this value only unwinds the mutation and is never
* rendered. Adding a string to 12 catalogs for text no user reads would be worse
* than a sentinel.
*/
var FLUSH_FAILED = "papyrus: buffer flush failed";
/** True for the flush-abort sentinel above, so a mutation that bailed on an
*  unsaveable buffer does not overwrite the real write error with it. */
var isFlushAbort = (err) => err.message === FLUSH_FAILED;
/**
* Instructions handed to the co-author AGENT, not shown to the user.
*
* Deliberately not catalog keys: this is prompt text the model reads, and the
* skill name and file-path semantics it references are English identifiers.
* Translating it would degrade the model's instruction-following without
* changing anything the user sees. Module-level so the i18n lint reads them as
* constants rather than inline copy.
*/
function PapyrusPage() {
	const { confirm, confirmDialog } = useConfirm();
	const queryClient = useQueryClient();
	const { openChat } = useChatLauncher();
	const [project, setProject] = useState(loadLastProject);
	const [currentFile, setCurrentFile] = useState("");
	const [buffer, setBuffer] = useState("");
	const [dirty, setDirty] = useState(false);
	const [diagnostics, setDiagnostics] = useState([]);
	const [compileLog, setCompileLog] = useState("");
	const [showDiagnostics, setShowDiagnostics] = useState(false);
	const [pdfVersion, setPdfVersion] = useState(0);
	const [hasPdf, setHasPdf] = useState(false);
	const [compileMs, setCompileMs] = useState(null);
	const [cursor, setCursor] = useState({
		line: 1,
		column: 1
	});
	const isMobile = useIsMobile();
	const [treeOpen, setTreeOpen] = useState(false);
	const pdfMax = maxPdfWidth(useSyncExternalStore(subscribeViewportWidth, readViewportWidth, readServerViewportWidth));
	const tree = useColumnResize(TREE_WIDTH_KEY, loadTreeWidth, 120, 420, TREE_COLLAPSE, loadTreeCollapsed);
	const pdf = useColumnResize(PDF_WIDTH_KEY, loadPdfWidth, 280, pdfMax, void 0, void 0, "left");
	const [error, setError] = useState("");
	const [conflictFile, setConflictFile] = useState(null);
	const editorRef = useRef(null);
	const bufferFileRef = useRef("");
	const dirtyRef = useRef(false);
	const conflictFileRef = useRef(null);
	const bufferRef = useRef("");
	const compilingRef = useRef(false);
	useEffect(() => {
		bufferFileRef.current = currentFile;
	}, [currentFile]);
	useEffect(() => {
		dirtyRef.current = dirty;
	}, [dirty]);
	useEffect(() => {
		conflictFileRef.current = conflictFile;
	}, [conflictFile]);
	useEffect(() => {
		bufferRef.current = buffer;
	}, [buffer]);
	useEffect(() => {
		saveLastProject(project);
	}, [project]);
	const projectQuery = useQuery({
		queryKey: projectQueryKey(project),
		queryFn: () => papyrusApi.getProject(project),
		enabled: !!project,
		retry: false,
		staleTime: 3e4
	});
	const detail = projectQuery.data;
	const mainFile = detail?.main_file ?? "";
	const files = useMemo(() => detail?.files ?? [], [detail]);
	useEffect(() => {
		if (!projectQuery.isError) return;
		setError(projectQuery.error instanceof Error ? projectQuery.error.message : String(projectQuery.error));
		if (!projectQuery.data) setProject(null);
	}, [
		projectQuery.isError,
		projectQuery.error,
		projectQuery.data
	]);
	useEffect(() => {
		if (detail) setHasPdf(detail.has_pdf);
	}, [detail]);
	const fileQuery = useQuery({
		queryKey: [
			"papyrus",
			"file",
			project,
			currentFile
		],
		queryFn: () => papyrusApi.readFile(project, currentFile),
		enabled: !!project && !!currentFile,
		staleTime: Infinity,
		refetchOnWindowFocus: false,
		retry: false
	});
	useEffect(() => {
		if (fileQuery.data && fileQuery.data.path === currentFile && !dirty) setBuffer(fileQuery.data.content);
	}, [fileQuery.data, currentFile]);
	const contentIsStale = Boolean(currentFile) && fileQuery.data?.path !== currentFile;
	const hasConflict = Boolean(currentFile) && conflictFile === currentFile;
	useEffect(() => {
		if (mainFile && !currentFile) {
			setCurrentFile(mainFile);
			setDirty(false);
		}
	}, [mainFile, currentFile]);
	const saveMutation = useMutation({
		mutationFn: (payload) => papyrusApi.saveFile(project, payload.path, payload.content),
		onSuccess: (_data, vars) => {
			queryClient.setQueryData([
				"papyrus",
				"file",
				project,
				vars.path
			], {
				path: vars.path,
				content: vars.content
			});
		},
		onError: (err) => setError(err.message)
	});
	const invalidateFiles = useCallback(() => queryClient.invalidateQueries({ queryKey: projectQueryKey(project) }), [queryClient, project]);
	/** Re-read the open file from disk. Used after the agent edits the paper and
	*  after a git pull rewrites it.
	*
	*  Flushes a dirty buffer FIRST rather than clearing `dirty` and overwriting it.
	*  The passive adopt effect above already refuses to overwrite an unsaved buffer;
	*  clearing the flag here would step around that exact guard, so unsaved typing
	*  was destroyed by a background refresh the user never asked for — a pull
	*  finishing, or the co-author's turn ending. The buffer is memory-only, so that
	*  is real data loss, not a stale read.
	*
	*  The save is what makes the subsequent read safe: the user's text is on disk
	*  before the fresh copy replaces the buffer, so the worst case is a visible
	*  merge conflict in git rather than silently vanished work. A failed flush
	*  ABORTS the reload — keeping the edit on screen beats replacing it with disk
	*  content the user never saw. */
	/**
	* Persist the buffer if it is dirty. Returns false when the write FAILED.
	*
	* The single guard every "something is about to replace or leave this buffer"
	* path goes through — leaving the workspace, switching files, creating a file,
	* pulling, and the post-agent refresh. The buffer is memory-only, so anything
	* that resets or overwrites it without coming through here destroys the user's
	* text outright rather than merely showing something stale. Callers must treat
	* `false` as "do not proceed": continuing past a failed flush discards exactly
	* the work the flush exists to protect.
	*/
	const flushBuffer = useCallback(async () => {
		if (!dirtyRef.current || !bufferFileRef.current) return true;
		if (conflictFileRef.current === bufferFileRef.current) return false;
		const written = bufferRef.current;
		const writtenTo = bufferFileRef.current;
		try {
			await saveMutation.mutateAsync({
				path: writtenTo,
				content: written
			});
		} catch {
			return false;
		}
		if (bufferFileRef.current !== writtenTo || bufferRef.current !== written) return false;
		dirtyRef.current = false;
		setDirty(false);
		return true;
	}, [saveMutation]);
	/**
	* Re-read the open file from disk.
	*
	* `flushWhenDirty` decides what happens to an UNSAVED buffer, and the two callers
	* genuinely want opposite things:
	*
	* - **pull** (`true`) already flushed before the rebase, so its inner flush is a
	*   no-op that only keeps the function idempotent. Flushing is also correct there:
	*   the user's text predates the merge and belongs on disk before it.
	* - **the co-author refresh** (`false`) is the opposite case. The agent just
	*   edited this file, and the browser buffer is what is stale. Flushing first
	*   SAVED that stale buffer over the agent's changes and then read the file back —
	*   so the agent's work was destroyed by the very refresh meant to display it, and
	*   the reload then showed the overwrite as if it were the result.
	*
	* With `false`, a dirty buffer is instead left exactly as it is: the disk keeps the
	* agent's version, the editor keeps the user's typing, and the post-await guard
	* below declines to overwrite. Nothing is lost on either side, and the user's next
	* save is a deliberate act on a document they can see. The conflict surfaces as
	* "refuse to clobber" rather than a modal — consistent with how `flushBuffer`
	* already reports a mid-save keystroke.
	*/
	const reloadOpenFile = useCallback(async (flushWhenDirty = true) => {
		if (!project || !currentFile) return false;
		if (flushWhenDirty) {
			if (!await flushBuffer()) return false;
			setDirty(false);
		} else if (dirtyRef.current) {
			setConflictFile(currentFile);
			return false;
		}
		const readFrom = currentFile;
		const fresh = await queryClient.fetchQuery({
			queryKey: [
				"papyrus",
				"file",
				project,
				currentFile
			],
			queryFn: () => papyrusApi.readFile(project, currentFile),
			staleTime: 0
		});
		if (bufferFileRef.current !== readFrom || dirtyRef.current) {
			if (!flushWhenDirty && dirtyRef.current && bufferFileRef.current === readFrom) {
				conflictFileRef.current = readFrom;
				setConflictFile(readFrom);
			}
			return false;
		}
		setBuffer(fresh.content);
		if (conflictFileRef.current === readFrom) {
			conflictFileRef.current = null;
			setConflictFile(null);
		}
		return true;
	}, [
		project,
		currentFile,
		flushBuffer,
		queryClient
	]);
	/** Take the agent's version, discarding the unsaved buffer.
	
	* The one exit from a conflict. Deliberately "theirs wins" rather than a merge UI:
	* the agent's copy is on disk and complete, the buffer is an interrupted edit, and
	* the user can re-apply their change on top of a document they can now see. A merge
	* view is a real feature — this is the escape hatch that keeps the block honest.
	*/
	const resolveConflict = useCallback(async () => {
		const conflicted = conflictFileRef.current;
		if (dirtyRef.current && !await confirm({
			title: i18nT("apps.papyrus.workspace.co_author_conflict_discard_title"),
			body: i18nT("apps.papyrus.workspace.co_author_conflict_discard_confirm", { file: conflicted ?? "" }),
			confirmLabel: i18nT("apps.papyrus.workspace.co_author_conflict_discard_button")
		})) return;
		conflictFileRef.current = null;
		setConflictFile(null);
		dirtyRef.current = false;
		setDirty(false);
		let adopted = false;
		try {
			adopted = await reloadOpenFile(false);
		} catch {
			adopted = false;
		}
		if (!adopted) {
			conflictFileRef.current = conflicted;
			setConflictFile(conflicted);
			dirtyRef.current = true;
			setDirty(true);
		}
	}, [reloadOpenFile, confirm]);
	const applyCompileResult = useCallback((result) => {
		setDiagnostics(Array.isArray(result.errors) ? result.errors : []);
		setCompileLog(result.log || "");
		setCompileMs(result.duration_ms || null);
		if (result.ok) {
			setHasPdf(true);
			setPdfVersion((v) => v + 1);
			setShowDiagnostics(false);
		} else setShowDiagnostics(true);
	}, []);
	const saveAndCompile = useCallback(async () => {
		if (!project || compilingRef.current) return;
		compilingRef.current = true;
		setCompiling(true);
		try {
			if (!await flushBuffer()) return;
			applyCompileResult(await papyrusApi.compile(project));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			compilingRef.current = false;
			setCompiling(false);
		}
	}, [
		project,
		flushBuffer,
		applyCompileResult
	]);
	const [compiling, setCompiling] = useState(false);
	const openFile = useCallback(async (path) => {
		if (isMobile) setTreeOpen(false);
		if (!project || path === bufferFileRef.current) return;
		if (!await flushBuffer()) return;
		setDirty(false);
		setCurrentFile(path);
	}, [
		project,
		flushBuffer,
		isMobile
	]);
	const createFileMutation = useMutation({
		mutationFn: async (path) => {
			if (!await flushBuffer()) throw new Error(FLUSH_FAILED);
			return papyrusApi.createFile(project, path);
		},
		onSuccess: async (result) => {
			await invalidateFiles();
			setDirty(false);
			setCurrentFile(result.path);
		},
		onError: (err) => {
			if (!isFlushAbort(err)) setError(err.message);
		}
	});
	const deleteFileMutation = useMutation({
		mutationFn: (path) => papyrusApi.deleteFile(project, path),
		onSuccess: async (_result, path) => {
			await invalidateFiles();
			if (path === bufferFileRef.current) {
				setDirty(false);
				setCurrentFile(mainFile);
			}
		},
		onError: (err) => setError(err.message)
	});
	const setMainMutation = useMutation({
		mutationFn: (path) => papyrusApi.setMainFile(project, path),
		onSuccess: () => invalidateFiles(),
		onError: (err) => setError(err.message)
	});
	const git = useQuery({
		queryKey: [
			"papyrus",
			"git",
			project
		],
		queryFn: () => papyrusApi.gitStatus(project),
		enabled: !!project,
		retry: false
	}).data;
	const invalidateGit = useCallback(() => queryClient.invalidateQueries({ queryKey: [
		"papyrus",
		"git",
		project
	] }), [queryClient, project]);
	const pullMutation = useMutation({
		mutationFn: async () => {
			if (!await flushBuffer()) throw new Error(FLUSH_FAILED);
			return papyrusApi.gitPull(project);
		},
		onSuccess: async () => {
			await invalidateGit();
			await invalidateFiles();
			await reloadOpenFile();
		},
		onError: (err) => {
			if (!isFlushAbort(err)) setError(err.message);
		}
	});
	const pushMutation = useMutation({
		mutationFn: async (message) => {
			if (!await flushBuffer()) throw new Error(FLUSH_FAILED);
			await papyrusApi.gitCommit(project, message);
			return papyrusApi.gitPush(project);
		},
		onSuccess: () => invalidateGit(),
		onError: (err) => {
			if (!isFlushAbort(err)) setError(err.message);
		}
	});
	const onCommitAndPushClick = useCallback(() => {
		const message = window.prompt(i18nT("apps.papyrus.workspace.commit_message_prompt"));
		if (message === null) return;
		pushMutation.mutate(message.trim());
	}, [pushMutation]);
	/** The context the writing assistant needs: the paper's name and main document.
	*  The bundled `papyrus-writing` skill supplies everything else (where projects
	*  live, how to compile, the style rules). */
	const companionContext = useCallback(() => {
		return companionContextLines(project ?? "", mainFile).join("\n");
	}, [project, mainFile]);
	/** Save the paper, then open a new co-author chat in Sessions.
	*
	* The built-in embedded the chat beside the PDF. An installed app can embed a
	* chat only with the `/api/chat` and `/api/chat/slots` grants, which the
	* built-in never declared and an adopted copy may not add (adoption refuses a
	* widened grant), so the co-author opens in Sessions instead: a persistent-memory
	* chat whose message box holds the paper's context, ready for the request to be
	* typed after it. Leaving the page unmounts the editor, so the buffer is flushed
	* first, and a failed flush stays here (its error is already on screen). */
	const openCoAuthor = useCallback(async () => {
		if (!await flushBuffer()) return;
		openChat({
			message: companionContext() + "\n\n",
			memoryMode: "persistent"
		});
	}, [
		flushBuffer,
		openChat,
		companionContext
	]);
	/** Record a conflict when the open file changed on disk under an unsaved buffer.
	*
	* The base is the cached copy of the file: what the buffer was last loaded from
	* or saved as (`saveMutation.onSuccess` keeps it current). A disk copy that no
	* longer matches it was written by someone else, usually the co-author, and the
	* next save would write the buffer over it. Recording the conflict makes the
	* editor read-only with the "Co-author changed this file" notice, whose only
	* exit is `resolveConflict`. A disk copy that still matches the base is no
	* conflict, so leaving the tab with unsaved typing and coming back blocks
	* nothing. The cache is left alone: the base must stay what the buffer started
	* from. */
	const detectDiskChange = useCallback(async () => {
		const path = bufferFileRef.current;
		if (!project || !path || !dirtyRef.current) return;
		const base = queryClient.getQueryData([
			"papyrus",
			"file",
			project,
			path
		]);
		if (!base) return;
		if ((await papyrusApi.readFile(project, path)).content === base.content) return;
		if (bufferFileRef.current !== path || !dirtyRef.current) return;
		conflictFileRef.current = path;
		setConflictFile(path);
	}, [project, queryClient]);
	useEffect(() => {
		const onVisible = () => {
			if (document.visibilityState !== "visible" || !project) return;
			(async () => {
				try {
					await invalidateFiles();
					if (dirtyRef.current) await detectDiskChange();
					else await reloadOpenFile(false);
				} catch {}
			})();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, [
		project,
		invalidateFiles,
		reloadOpenFile,
		detectDiskChange
	]);
	const counts = useMemo(() => countDiagnostics(diagnostics), [diagnostics]);
	const wordCount = useMemo(() => countWords(buffer), [buffer]);
	const branchLabel = gitBranchLabel(git);
	const editingLabel = currentFile && (dirty || currentFile !== mainFile) ? dirty ? i18nT("apps.papyrus.workspace.editing_unsaved", { file: currentFile }) : i18nT("apps.papyrus.workspace.editing", { file: currentFile }) : "";
	const pdfSrc = project && hasPdf ? pdfUrl(project, pdfVersion) : null;
	const mainCandidates = useMemo(() => texFiles(files), [files]);
	const mainOptions = useMemo(() => mainCandidates.map((file) => ({
		value: file,
		label: file
	})), [mainCandidates]);
	useEffect(() => {
		if (!dirty) return;
		const warn = (event) => {
			event.preventDefault();
			event.returnValue = "";
			return "";
		};
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [dirty]);
	const closeProject = useCallback(async () => {
		if (project && !await flushBuffer()) return;
		setProject(null);
		setCurrentFile("");
		setBuffer("");
		setDirty(false);
		setDiagnostics([]);
		setCompileLog("");
		setHasPdf(false);
		setCompileMs(null);
	}, [project, flushBuffer]);
	const openProject = useCallback((name) => {
		setError("");
		setProject(name);
		setCurrentFile("");
		setBuffer("");
		setDirty(false);
		setDiagnostics([]);
		setCompileLog("");
		setCompileMs(null);
	}, []);
	const onCreateFileClick = useCallback(() => {
		const trimmed = window.prompt(i18nT("apps.papyrus.workspace.new_file_prompt"))?.trim();
		if (trimmed) createFileMutation.mutate(trimmed);
	}, [createFileMutation]);
	const onDeleteFileClick = useCallback((path) => {
		if (window.confirm(i18nT("apps.papyrus.workspace.delete_file_confirm", { file: path }))) deleteFileMutation.mutate(path);
	}, [deleteFileMutation]);
	if (!project) return /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx(ErrorNotice, {
		className: "mx-6 mt-2 animate-rise",
		message: error,
		onDismiss: () => setError("")
	}), /* @__PURE__ */ jsx(ProjectList, { onOpenProject: openProject })] });
	return /* @__PURE__ */ jsxs("div", {
		className: `flex flex-col flex-1 ${isMobile ? "min-h-0" : ""}`,
		"data-testid": "papyrus-workspace",
		children: [
			/* @__PURE__ */ jsxs("div", {
				className: "flex flex-wrap items-center gap-2 px-3 py-2 border-b border-border bg-card shrink-0",
				children: [
					/* @__PURE__ */ jsxs(Btn, {
						onClick: closeProject,
						children: [/* @__PURE__ */ jsx(ArrowLeft, { className: "lucide-inline" }), i18nT("apps.papyrus.workspace.papers")]
					}),
					/* @__PURE__ */ jsx("span", {
						className: "text-[13px] font-medium text-text-strong truncate max-w-[12rem]",
						children: detail?.title || project
					}),
					/* @__PURE__ */ jsxs("span", {
						className: "flex flex-wrap items-center gap-1.5 shrink-0 max-w-full text-[12px] text-muted",
						children: [/* @__PURE__ */ jsx("span", {
							className: "whitespace-nowrap",
							children: i18nT("apps.papyrus.workspace.main_document")
						}), /* @__PURE__ */ jsx("span", {
							className: "flex w-56 max-w-full shrink-0",
							children: /* @__PURE__ */ jsx(SearchableSelect, {
								options: mainOptions,
								value: mainFile,
								onChange: (file) => setMainMutation.mutate(file),
								disabled: setMainMutation.isPending || mainCandidates.length === 0,
								"aria-label": i18nT("apps.papyrus.workspace.main_document")
							})
						})]
					}),
					editingLabel && /* @__PURE__ */ jsx("span", {
						className: "flex-1 basis-0 min-w-[6rem] text-[12px] text-muted truncate",
						title: editingLabel,
						children: editingLabel
					}),
					hasConflict && /* @__PURE__ */ jsxs("span", {
						className: "flex items-center gap-2 text-[12px] text-warn",
						children: [
							/* @__PURE__ */ jsx(AlertTriangle, { className: "lucide-inline" }),
							i18nT("apps.papyrus.workspace.co_author_conflict"),
							/* @__PURE__ */ jsx(Btn, {
								onClick: resolveConflict,
								children: i18nT("apps.papyrus.workspace.co_author_conflict_discard")
							})
						]
					}),
					!editingLabel && /* @__PURE__ */ jsx("div", { className: "flex-1" }),
					/* @__PURE__ */ jsxs(Btn, {
						primary: true,
						onClick: saveAndCompile,
						disabled: compiling,
						children: [compiling ? /* @__PURE__ */ jsx(Loader2, { className: "lucide-inline animate-spin motion-reduce:animate-none" }) : /* @__PURE__ */ jsx(Play, { className: "lucide-inline" }), compiling ? i18nT("apps.papyrus.workspace.compiling") : i18nT("apps.papyrus.workspace.compile")]
					}),
					/* @__PURE__ */ jsxs(Btn, {
						onClick: () => setShowDiagnostics((v) => !v),
						"aria-pressed": showDiagnostics,
						children: [
							/* @__PURE__ */ jsx(TerminalSquare, { className: "lucide-inline" }),
							i18nT("apps.papyrus.workspace.log"),
							counts.errors > 0 && /* @__PURE__ */ jsx("span", {
								className: "ml-1 text-danger",
								children: counts.errors
							})
						]
					}),
					pdfSrc && /* @__PURE__ */ jsxs("a", {
						href: pdfSrc,
						download: `${project}.pdf`,
						className: "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border text-[13px] text-muted hover:text-text hover:border-border-strong hover:bg-bg-hover no-underline transition-all focus-ring",
						children: [/* @__PURE__ */ jsx(FileDown, { className: "lucide-inline" }), i18nT("apps.papyrus.workspace.download_pdf")]
					}),
					git?.is_git && /* @__PURE__ */ jsxs(Fragment, { children: [
						/* @__PURE__ */ jsxs("span", {
							className: "font-mono text-[12px] text-muted",
							title: i18nT("apps.papyrus.workspace.git_branch"),
							children: [
								branchLabel,
								!!git.ahead && ` +${git.ahead}`,
								!!git.behind && ` -${git.behind}`
							]
						}),
						git.has_remote && /* @__PURE__ */ jsxs(Btn, {
							onClick: () => pullMutation.mutate(),
							disabled: pullMutation.isPending,
							children: [pullMutation.isPending ? /* @__PURE__ */ jsx(Loader2, { className: "lucide-inline animate-spin motion-reduce:animate-none" }) : /* @__PURE__ */ jsx(ArrowDownToLine, { className: "lucide-inline" }), i18nT("apps.papyrus.workspace.pull")]
						}),
						/* @__PURE__ */ jsxs(Btn, {
							onClick: onCommitAndPushClick,
							disabled: pushMutation.isPending,
							children: [pushMutation.isPending ? /* @__PURE__ */ jsx(Loader2, { className: "lucide-inline animate-spin motion-reduce:animate-none" }) : /* @__PURE__ */ jsx(ArrowUpFromLine, { className: "lucide-inline" }), i18nT("apps.papyrus.workspace.commit_and_push")]
						})
					] }),
					/* @__PURE__ */ jsxs(Btn, {
						onClick: () => {
							openCoAuthor();
						},
						title: i18nT("apps.papyrus.coAuthor.open_in_chat_page"),
						children: [/* @__PURE__ */ jsx(Sparkles, { className: "lucide-inline" }), i18nT("apps.papyrus.workspace.co_author")]
					})
				]
			}),
			/* @__PURE__ */ jsx(ErrorNotice, {
				className: "mx-3 mt-2 animate-rise",
				message: error,
				onDismiss: () => setError("")
			}),
			/* @__PURE__ */ jsxs("div", {
				className: `flex flex-1 ${isMobile ? "min-h-0 flex-col" : ""}`,
				children: [
					/* @__PURE__ */ jsxs("div", {
						className: `flex flex-col flex-1 min-w-0 ${isMobile ? "min-h-0" : ""}`,
						children: [
							isMobile && /* @__PURE__ */ jsxs(Btn, {
								onClick: () => setTreeOpen(!treeOpen),
								"aria-expanded": treeOpen,
								className: "shrink-0 w-full justify-start gap-1.5 rounded-none border-x-0 border-t-0",
								children: [treeOpen ? /* @__PURE__ */ jsx(ChevronUp, { className: "lucide-inline" }) : /* @__PURE__ */ jsx(ChevronDown, { className: "lucide-inline" }), i18nT("apps.papyrus.fileTree.files")]
							}),
							/* @__PURE__ */ jsxs("div", {
								className: `flex flex-1 ${isMobile ? "min-h-0 flex-col" : "min-h-[180px] [contain:size]"}`,
								children: [
									/* @__PURE__ */ jsx("div", {
										className: `min-h-0 ${isMobile ? `w-full shrink-0 max-h-[40vh] overflow-y-auto ${treeOpen ? "" : "hidden"}` : "shrink-0 overflow-hidden"}`,
										style: { width: isMobile ? void 0 : tree.width },
										children: !isMobile && tree.collapsed ? /* @__PURE__ */ jsx(Btn, {
											onClick: tree.expand,
											"aria-label": i18nT("apps.papyrus.fileTree.files"),
											"aria-expanded": false,
											className: "w-full justify-center rounded-none border-0 px-0 py-2",
											children: /* @__PURE__ */ jsx(ChevronRight, { className: "lucide-inline" })
										}) : /* @__PURE__ */ jsx(FileTree, {
											files,
											currentFile,
											mainFile,
											onOpenFile: openFile,
											onCreateFile: onCreateFileClick,
											onDeleteFile: onDeleteFileClick
										})
									}),
									!isMobile && /* @__PURE__ */ jsx(ResizeHandle, {
										handleProps: tree.handleProps,
										label: i18nT("pages.chat.fileBrowserRail.resize"),
										onNudge: tree.nudge,
										value: tree.collapsed ? 120 : tree.width,
										min: 120,
										max: 420
									}),
									/* @__PURE__ */ jsx("div", {
										className: "flex-1 min-w-0 min-h-0",
										children: /* @__PURE__ */ jsx(PapyrusEditor, {
											ref: editorRef,
											path: currentFile || mainFile || "main.tex",
											value: buffer,
											onChange: (value) => {
												setBuffer(value);
												bufferRef.current = value;
												dirtyRef.current = true;
												setDirty(true);
											},
											onSave: saveAndCompile,
											readOnly: contentIsStale || pullMutation.isPending || hasConflict || createFileMutation.isPending || deleteFileMutation.isPending,
											diagnostics: currentFile === mainFile ? diagnostics : [],
											onCursorChange: (line, column) => setCursor({
												line,
												column
											})
										})
									})
								]
							}),
							/* @__PURE__ */ jsxs("div", {
								className: "flex items-center gap-4 px-3 py-1 border-t border-border bg-bg-accent text-[12px] text-muted shrink-0",
								children: [
									/* @__PURE__ */ jsx("span", {
										title: i18nT("apps.papyrus.workspace.save_and_compile_hint"),
										children: i18nT("apps.papyrus.workspace.cursor_position", {
											line: cursor.line,
											column: cursor.column
										})
									}),
									/* @__PURE__ */ jsx("span", { children: i18nT("apps.papyrus.workspace.word_count", { count: wordCount }) }),
									compileMs !== null && /* @__PURE__ */ jsx("span", { children: compileDurationLabel(compileMs) }),
									counts.errors > 0 && /* @__PURE__ */ jsx("span", {
										className: "text-danger",
										children: i18nT("apps.papyrus.workspace.error_count", { count: counts.errors })
									}),
									counts.warnings > 0 && /* @__PURE__ */ jsx("span", {
										className: "text-warn",
										children: i18nT("apps.papyrus.workspace.warning_count", { count: counts.warnings })
									})
								]
							}),
							showDiagnostics && /* @__PURE__ */ jsx("div", {
								className: "border-t border-border bg-card overflow-hidden shrink-0",
								children: /* @__PURE__ */ jsx("div", {
									className: "max-h-56 overflow-x-hidden overflow-y-auto",
									children: /* @__PURE__ */ jsx(DiagnosticsList, {
										diagnostics,
										log: compileLog,
										onJumpToLine: (line) => editorRef.current?.jumpToLine(line)
									})
								})
							})
						]
					}),
					!isMobile && /* @__PURE__ */ jsx(ResizeHandle, {
						handleProps: pdf.handleProps,
						label: i18nT("apps.specBuilder.components.specDetail.resize_document_panel"),
						onNudge: pdf.nudge,
						value: pdf.width,
						min: 280,
						max: pdfMax
					}),
					/* @__PURE__ */ jsx("div", {
						className: `flex flex-col min-w-0 min-h-0 ${isMobile ? "w-full shrink-0 max-h-[45vh] border-t border-border" : "shrink-0 border-l border-border"}`,
						style: { width: isMobile ? void 0 : pdf.width },
						children: /* @__PURE__ */ jsx(PdfPreview, {
							src: pdfSrc,
							downloadName: `${project}.pdf`
						})
					})
				]
			}),
			confirmDialog
		]
	});
}
// src/index.tsx
/**
* The bundle's entry: AppHost lazy-imports this module and renders its default
* export as the app's page.
*
* Two things happen here once, for the whole page. The host's permission-scoped
* API client becomes the transport every Papyrus call goes through
* (`api.setTransport`), and the host's language generation is subscribed to,
* which repaints the page on a language switch: `t` reads the active locale at
* call time, and this component's re-render reaches every child.
*/
function PapyrusApp() {
	useLanguageGeneration();
	setTransport(useAppApi());
	return /* @__PURE__ */ jsx("div", {
		className: "flex flex-col flex-1 min-h-0 h-full",
		children: /* @__PURE__ */ jsx(PapyrusPage, {})
	});
}
export { PapyrusApp as default };

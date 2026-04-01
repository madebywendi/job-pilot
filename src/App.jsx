/*
 * JOB PILOT - OPTIMIZED v4.1
 * 
 * PERFORMANCE FIXES APPLIED:
 * 
 * 1. REAL STREAMING ✓
 *    - SSE streaming for word-by-word AI output
 * 
 * 2. REMOVED NOTEPAD + JOB SOURCES TABS ✓
 *    - Cleaned up dead code (sticky note constants, discovery card)
 *    - WelcomePage features list cleaned (5 modules, not 7)
 * 
 * 3. React.memo ON ALL HEAVY TABS ✓
 *    - ProfileTab, TrackerTab, FileGenTab, InterviewTab, CareerDevTab
 *    - Prevents full re-render when switching tabs or updating state
 * 
 * 4. REMOVED AI AUTOCOMPLETE ✓ (v4.1)
 *    - AutocompleteTagAdder now uses static suggestions only
 *    - No more API calls on every keystroke
 * 
 * 5. REMOVED SIDEBAR SHORTCUTS ✓ (v4.1)
 *    - Eliminated expensive array operations on every render
 * 
 * 6. KEPT PREVIOUS OPTIMIZATIONS ✓
 *    - Debounced storage writes (500ms)
 *    - Correct model: claude-sonnet-4-20250514
 *    - Event loop yielding during AI extraction
 */

import { useState, useRef, useEffect, memo, useCallback, useMemo } from "react";
import * as mammoth from "mammoth";

// ── FILE PARSER (txt / md / pdf / docx) ───────────────────────────────────────
const parseFile = (file) => new Promise((resolve, reject) => {
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "pdf") {
    const script = document.getElementById("pdfjs-script");
    const run = () => {
      const pdfjsLib = window["pdfjs-dist/build/pdf"];
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          const pdf = await pdfjsLib.getDocument({ data: ev.target.result }).promise;
          let text = "";
          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            text += content.items.map(item => item.str).join(" ") + "\n";
          }
          resolve(text.trim());
        } catch (e) { reject(e); }
      };
      reader.readAsArrayBuffer(file);
    };
    if (script) { run(); }
    else {
      const s = document.createElement("script");
      s.id = "pdfjs-script";
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      s.onload = run;
      s.onerror = () => reject(new Error("Failed to load PDF.js"));
      document.head.appendChild(s);
    }
  } else if (ext === "docx") {
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const result = await mammoth.extractRawText({ arrayBuffer: ev.target.result });
        resolve(result.value.trim());
      } catch (e) { reject(e); }
    };
    reader.readAsArrayBuffer(file);
  } else {
    const reader = new FileReader();
    reader.onload = (ev) => resolve(ev.target.result);
    reader.onerror = reject;
    reader.readAsText(file);
  }
});

// ── DEBOUNCED STORAGE HOOK ────────────────────────────────────────────────────
// PERFORMANCE FIX: Only writes to storage after 500ms of inactivity
// Prevents hammering the storage API on every keystroke/change
const useDebouncedStorage = (key, value, delay = 500) => {
  const timeoutRef = useRef(null);
  
  useEffect(() => {
    if (value === null || value === undefined) return;
    
    // Clear existing timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    
    // Set new timeout
    timeoutRef.current = setTimeout(() => {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {
        console.error("Storage write failed:", e);
      }
    }, delay);
    
    // Cleanup
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [key, value, delay]);
};

// ── THEME ─────────────────────────────────────────────────────────────────────
const T = {
  bg: "#d6dfe8",
  bgPanel: "#e8eff5",
  bgInset: "#f2f6fa",
  border: "#a8bbc8",
  borderLight: "#c4d4e0",
  accent: "#2e5f8a",
  accentLight: "#4777a0",
  accentBg: "#ccdff0",
  amber: "#8a5e20",
  amberBg: "#f0e0c0",
  green: "#2a6644",
  greenBg: "#c8e4d4",
  red: "#8a2e2e",
  redBg: "#f0cccc",
  textPrimary: "#1a2830",
  textSecondary: "#3a5060",
  textMuted: "#6a8090",
  textFaint: "#98aab8",
  shadow: "2px 2px 0px #a0b4c4",
  shadowInset: "inset 1px 1px 2px #b8cad8, inset -1px -1px 0 #fff",
  fontVT: "'VT323', monospace",
  fontMono: "'Courier New', monospace",
};


const COL_COLORS = {
  Saved: T.textMuted, Applied: T.accent, "Phone Screen": T.amber,
  Interview: "#2a5a8a", Offer: T.green, Rejected: T.red
};
const ALL_STATUSES = Object.keys(COL_COLORS);
const COL_BG = {
  Saved: "#dde6ee", Applied: T.accentBg, "Phone Screen": T.amberBg,
  Interview: "#c4d8ec", Offer: T.greenBg, Rejected: T.redBg
};
// Aliases for SpreadsheetRow
const STATUS_COLOR = COL_COLORS;
const STATUS_BG = COL_BG;

const callClaude = async (systemPrompt, userPrompt, maxTokens = 2000, onChunk = null, signal = null) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 300_000); // 5 minutes
  if (signal) signal.addEventListener("abort", () => ctrl.abort());
  
  try {
    const res = await fetch("/api/claude", {
      method: "POST",
      signal: ctrl.signal,
      headers: { 
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        stream: true
      })
    });

    if (!res.ok) {
      let msg = `API error ${res.status}`;
      try { const e = await res.json(); msg = e.error?.message || msg; } catch {}
      throw new Error(msg);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let buffer = "";
    let lastUpdate = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data || data === "[DONE]") continue;
          
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === "content_block_delta" && parsed.delta?.text) {
            fullText += parsed.delta.text;
          }
        } catch {}
      }
      
      // Throttle UI updates to every 200ms to prevent React overload
      const now = Date.now();
      if (onChunk && now - lastUpdate > 200) {
        onChunk(fullText);
        lastUpdate = now;
        // Yield to prevent UI freeze
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // Final update with complete text
    if (onChunk) onChunk(fullText);
    return fullText || "No response received.";
  } catch (e) {
    console.error("callClaude error:", e);
    if (e.name === "AbortError" && !signal?.aborted) throw new Error("Request timed out — please try again.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
};

const buildContext = (profile) => {
  const exp = (profile.experience || []).map(e =>
    `${e.role || ""}${e.company ? " at " + e.company : ""}${e.dates ? " ("+e.dates+")" : ""}${e.details ? ": " + e.details : ""}`
  ).join("\n");
  const edu = (profile.education || []).map(e =>
    `${e.degree || ""}${e.areaOfStudy ? ", " + e.areaOfStudy : ""}${e.school ? " — " + e.school : ""}${e.dates ? " ("+e.dates+")" : ""}`
  ).join("\n");
  return [
    profile.name ? `Name: ${profile.name}` : "",
    profile.linkedin ? `LinkedIn: ${profile.linkedin}` : "",
    profile.portfolio ? `Portfolio: ${profile.portfolio}` : "",
    profile.summary ? `\nSUMMARY:\n${profile.summary}` : "",
    profile.keywords ? `\nKEY SKILLS & KEYWORDS:\n${profile.keywords}` : "",
    exp ? `\nEXPERIENCE:\n${exp}` : "",
    edu ? `\nEDUCATION:\n${edu}` : "",
    profile.strengths ? `\nADDITIONAL STRENGTHS:\n${profile.strengths}` : "",
    profile.savedRoles?.length ? `\nTARGET ROLES: ${profile.savedRoles.join(", ")}` : "",
    profile.savedIndustries?.length ? `\nTARGET INDUSTRIES: ${profile.savedIndustries.join(", ")}` : "",
  ].filter(Boolean).join("\n");
};

// ── PRIMITIVES ────────────────────────────────────────────────────────────────
function Panel({ children, style = {} }) {
  return (
    <div style={{ background: T.bgPanel, border: `1px solid ${T.border}`, borderRadius: 3, boxShadow: T.shadow, padding: 18, ...style }}>
      {children}
    </div>
  );
}

function FieldLabel({ children }) {
  return <div style={{ color: T.textMuted, fontSize: 14, fontFamily: T.fontVT, letterSpacing: 1.5, marginBottom: 5, textTransform: "uppercase" }}>{children}</div>;
}

function TextInput({ label, value, onChange, placeholder, style = {} }) {
  return (
    <div style={{ marginBottom: 14, ...style }}>
      {label && <FieldLabel>{label}</FieldLabel>}
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={{ width: "100%", background: T.bgInset, border: `1px solid ${T.border}`, borderRadius: 2, padding: "8px 10px", color: T.textPrimary, fontSize: 12, fontFamily: T.fontMono, outline: "none", boxSizing: "border-box", boxShadow: T.shadowInset }} />
    </div>
  );
}

function TextArea({ label, value, onChange, rows = 5, placeholder }) {
  return (
    <div style={{ marginBottom: 14 }}>
      {label && <FieldLabel>{label}</FieldLabel>}
      <textarea value={value} onChange={e => onChange(e.target.value)} rows={rows} placeholder={placeholder}
        style={{ width: "100%", background: T.bgInset, border: `1px solid ${T.border}`, borderRadius: 2, padding: "8px 10px", color: T.textPrimary, fontSize: 12, fontFamily: T.fontMono, resize: "vertical", outline: "none", boxSizing: "border-box", lineHeight: 1.6, boxShadow: T.shadowInset }} />
    </div>
  );
}

function Chip({ label, active, onClick, color }) {
  const c = color || (active ? T.accent : T.textMuted);
  return (
    <button onClick={onClick} style={{ padding: "3px 10px", borderRadius: 2, fontSize: 11, cursor: "pointer", fontFamily: T.fontMono, border: `1px solid ${active ? c : T.border}`, background: active ? (color ? color + "22" : T.accentBg) : T.bgInset, color: active ? c : T.textMuted, transition: "all .1s", boxShadow: active ? "none" : T.shadow }}>
      {label}
    </button>
  );
}

function Btn({ onClick, loading, disabled, label, variant = "primary", small }) {
  const bg = variant === "primary" ? T.accent : T.bgInset;
  const col = variant === "primary" ? "#fff" : T.textSecondary;
  return (
    <button onClick={onClick} disabled={loading || disabled}
      style={{ background: loading || disabled ? T.borderLight : bg, color: loading || disabled ? T.textFaint : col, border: `1px solid ${T.border}`, borderRadius: 2, padding: small ? "5px 12px" : "9px 18px", fontSize: small ? 11 : 12, fontFamily: T.fontVT, letterSpacing: 0.8, cursor: loading || disabled ? "not-allowed" : "pointer", boxShadow: loading || disabled ? "none" : T.shadow, transition: "all .1s", whiteSpace: "nowrap" }}>
      {loading ? "[ PROCESSING... ]" : label}
    </button>
  );
}

// FIXED CopyBtn — uses document.execCommand fallback for iframe environments
function CopyBtn({ text }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    const doCopy = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(doCopy).catch(() => {
        // fallback
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        doCopy();
      });
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      doCopy();
    }
  };
  return (
    <button onClick={handleCopy}
      style={{ background: copied ? T.greenBg : T.bgInset, border: `1px solid ${copied ? T.green : T.border}`, color: copied ? T.green : T.textMuted, borderRadius: 2, padding: "3px 10px", fontSize: 10, cursor: "pointer", fontFamily: T.fontVT, boxShadow: T.shadow }}>
      {copied ? "✓ COPIED" : "COPY"}
    </button>
  );
}

// AIOutput — shows streaming content live, skeleton only before first chunk, with cancel button
function AIOutput({ content, loading, onClear, onCancel }) {
  if (loading && !content) return (
    <Panel style={{ background: T.bgInset }}>
      <div style={{ color: T.accent, fontFamily: T.fontVT, fontSize: 14, marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ animation: "blink 1s infinite" }}>█</span> PROCESSING REQUEST...
        </span>
        {onCancel && <button onClick={onCancel} style={{ background: "transparent", border: `1px solid ${T.border}`, borderRadius: 2, color: T.textMuted, fontSize: 10, fontFamily: T.fontVT, padding: "2px 8px", cursor: "pointer" }}>CANCEL</button>}
      </div>
      {[85, 70, 90, 55].map((w, i) => <div key={i} style={{ height: 10, background: T.borderLight, borderRadius: 1, margin: "8px 0", width: `${w}%`, animation: "pulse 1.5s infinite", animationDelay: `${i * 0.15}s` }} />)}
    </Panel>
  );
  if (!content) return null;
  return (
    <div style={{ border: `1px solid ${T.border}`, borderRadius: 2, overflow: "hidden", boxShadow: T.shadow }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 12px", background: T.accentBg, borderBottom: `1px solid ${T.border}` }}>
        <span style={{ color: T.accent, fontSize: 11, fontFamily: T.fontVT, letterSpacing: 1, display: "flex", alignItems: "center", gap: 6 }}>
          {loading ? <><span style={{ animation: "blink 1s infinite" }}>█</span> STREAMING...</> : "◈ AI OUTPUT"}
        </span>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {loading && onCancel && <button onClick={onCancel} style={{ background: "transparent", border: `1px solid ${T.border}`, borderRadius: 2, color: T.textMuted, fontSize: 10, fontFamily: T.fontVT, padding: "2px 8px", cursor: "pointer" }}>CANCEL</button>}
          {!loading && <CopyBtn text={content} />}
          {!loading && onClear && (
            <button onClick={onClear} style={{ background: T.accentBg, border: `1px solid ${T.accent}44`, color: T.accent, borderRadius: 2, padding: "3px 8px", fontSize: 11, cursor: "pointer", fontFamily: T.fontVT, lineHeight: 1 }}>✕</button>
          )}
        </div>
      </div>
      <pre style={{ padding: 16, margin: 0, whiteSpace: "pre-wrap", color: T.textPrimary, fontSize: 12, lineHeight: 1.75, fontFamily: T.fontMono, background: T.bgInset, maxHeight: "70vh", overflowY: "auto" }}>{content}{loading && <span style={{ animation: "blink 1s infinite" }}>▌</span>}</pre>
    </div>
  );
}

function SectionTitle({ children }) {
  return <h2 style={{ fontFamily: T.fontVT, fontSize: 26, color: T.textPrimary, margin: "0 0 4px", letterSpacing: 1.5, lineHeight: 1.1 }}>{children}</h2>;
}
function SectionSub({ children }) {
  return <p style={{ fontFamily: T.fontMono, fontSize: 11, color: T.textMuted, margin: "0 0 22px", lineHeight: 1.6 }}>{children}</p>;
}


// ── AUTOCOMPLETE DATA ─────────────────────────────────────────────────────────
const ROLE_SUGGESTIONS = [
  "Account Manager","Account Executive","Art Director","Brand Manager","Brand Strategist",
  "Business Analyst","Business Development Manager","Campaign Manager","Chief Marketing Officer",
  "Communications Manager","Communications Specialist","Content Director","Content Manager",
  "Content Strategist","Content Writer","Copywriter","Creative Director","Creative Producer",
  "Creative Strategist","Customer Success Manager","Data Analyst","Design Director",
  "Digital Marketing Manager","Digital Marketing Specialist","Director of Marketing",
  "Email Marketing Manager","Event Manager","Executive Assistant","Graphic Designer",
  "Growth Manager","Growth Marketing Manager","Head of Content","Head of Marketing",
  "Illustrator","Influencer Marketing Manager","Integrated Marketing Manager",
  "Marketing Analyst","Marketing Coordinator","Marketing Director","Marketing Manager",
  "Marketing Operations Manager","Media Buyer","Media Planner","Motion Designer",
  "Operations Manager","Paid Media Manager","Partnership Manager","Product Designer",
  "Product Manager","Product Marketing Manager","Program Manager","Project Manager",
  "Public Relations Manager","Public Relations Specialist","SEO Manager","SEO Specialist",
  "Social Media Manager","Social Media Strategist","UX Designer","UX Researcher",
  "UX Writer","UI Designer","UI/UX Designer","Video Producer","Visual Designer",
  "Web Designer","Web Content Manager","Community Manager","Events Coordinator",
  "Marketing Associate","Marketing Specialist","Brand Designer","Creative Manager",
  "Strategy Director","Strategy Manager","Associate Creative Director"
];

const INDUSTRY_SUGGESTIONS = [
  "Advertising","Agency","Architecture","Arts & Culture","Beauty & Wellness",
  "B2B SaaS","Consumer Goods","Consumer Tech","CPG","Creative Services",
  "E-commerce","Education","Entertainment","Environmental","Fashion",
  "Fintech","Food & Beverage","Gaming","Government","Healthcare",
  "Hospitality","HR Tech","Impact & Social Good","Legal Tech","Lifestyle",
  "Logistics","Luxury Goods","Manufacturing","Media","Music",
  "Nonprofit","Pharma","PropTech","Publishing","Real Estate",
  "Retail","Social Impact","Sports & Fitness","Startup","Sustainability",
  "Tech","Travel","VC-Backed Startup","Wellness","Agency / Studio"
];

function AutocompleteTagAdder({ label, items, onAdd, onRemove, placeholder, color, suggestions }) {
  const [val, setVal] = useState("");
  const [focused, setFocused] = useState(false);
  const containerRef = useRef(null);
  const c = color || T.amber;

  // Static matches only — no AI API calls
  const matches = val.trim().length > 0
    ? suggestions.filter(s => s.toLowerCase().includes(val.toLowerCase()) && !items.includes(s)).slice(0, 8)
    : [];

  const add = (v) => {
    const trimmed = (v || val).trim();
    if (trimmed && !items.includes(trimmed)) { onAdd(trimmed); }
    setVal("");
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); add(); }
    if (e.key === "Escape") { setVal(""); }
  };

  useEffect(() => {
    const handler = (e) => { if (containerRef.current && !containerRef.current.contains(e.target)) setFocused(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const showDropdown = focused && val.trim().length > 0 && matches.length > 0;

  return (
    <div style={{ marginBottom: 16 }} ref={containerRef}>
      {label && <FieldLabel>{label}</FieldLabel>}
      <div style={{ position: "relative" }}>
        <div style={{ display: "flex", gap: 6, marginBottom: showDropdown ? 0 : 8 }}>
          <input
            value={val}
            onChange={e => setVal(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setFocused(true)}
            placeholder={placeholder}
            style={{ flex: 1, background: T.bgInset, border: `1px solid ${focused ? c : T.border}`, borderRadius: showDropdown ? "2px 2px 0 0" : 2, padding: "7px 10px", color: T.textPrimary, fontSize: 12, fontFamily: T.fontMono, outline: "none", boxShadow: T.shadowInset, transition: "border-color .1s" }}
          />
          <Btn onClick={() => add()} label="+ ADD" small variant="ghost" />
        </div>
        {showDropdown && (
          <div style={{ position: "absolute", top: "100%", left: 0, right: 42, zIndex: 50, background: T.bgPanel, border: `1px solid ${c}`, borderTop: `1px solid ${T.borderLight}`, borderRadius: "0 0 2px 2px", boxShadow: "2px 4px 8px rgba(0,0,0,0.12)", marginBottom: 8 }}>
            {matches.map((s, i) => (
              <div key={i} onMouseDown={() => add(s)}
                style={{ padding: "7px 12px", fontSize: 12, fontFamily: T.fontMono, color: T.textPrimary, cursor: "pointer", borderBottom: i < matches.length - 1 ? `1px solid ${T.borderLight}` : "none" }}
                onMouseEnter={e => e.currentTarget.style.background = c + "18"}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                {s}
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
        {items.map((r, i) => (
          <span key={i} style={{ background: c + "18", border: `1px solid ${c}55`, color: c, borderRadius: 2, padding: "3px 10px", fontSize: 11, fontFamily: T.fontMono, display: "flex", alignItems: "center", gap: 6 }}>
            {r}
            <button onClick={() => onRemove(i)} style={{ background: "none", border: "none", color: c, cursor: "pointer", padding: 0, fontSize: 11, lineHeight: 1, opacity: 0.7 }}>×</button>
          </span>
        ))}
        {items.length === 0 && <span style={{ color: T.textFaint, fontSize: 11, fontFamily: T.fontMono, fontStyle: "italic" }}>None added yet</span>}
      </div>
    </div>
  );
}

// ── WELCOME PAGE ──────────────────────────────────────────────────────────────
function WelcomePage({ onEnter, onGetStarted, onGoToTab, onShowTerms }) {
  const quickStartRef = useRef(null);
  const handleLaunch = () => {
    if (quickStartRef.current) quickStartRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const features = [
    { icon: "◉", title: "Job Seeker Profile", desc: "Everything starts here. Your Job Seeker Profile powers all other AI outputs across the app — with your unique background and experience especially in mind.", tab: "profile" },
    { icon: "◫", title: "Application Tracker", desc: "Keep track of every listing. Paste the JD once to auto-extract details that route you to the right AI tools automatically.", tab: "tracker" },
    { icon: "◧", title: "File Generator", desc: "Tailored cover letters and ATS-optimized resumes, customized for each role — built from your actual experience, not generic filler.", tab: "filegen" },
    { icon: "◎", title: "Interview Prep", desc: "One-sheet quick prep or complete interview guide: brand context, STAR answers, metrics, tools, live exercise prep, and salary negotiation — all personalized.", tab: "interview" },
    { icon: "✦", title: "Career Development", desc: "AI-powered role exploration, ATS keywords, boolean search strings, personal guidance, and career pivot mapping.", tab: "career" },
  ];
  return (
    <div style={{ minHeight: "100vh", background: T.bg, display: "flex", flexDirection: "column" }}>
      <link href="https://fonts.googleapis.com/css2?family=VT323&display=swap" rel="stylesheet" />
      <style>{`*{box-sizing:border-box;}@keyframes blink{0%,49%{opacity:1}50%,100%{opacity:0}}@keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}.wcard:hover{transform:translateY(-2px);box-shadow:3px 5px 0 #a0b4c4!important;}.enterbtn:hover{background:#1e4f7a!important;}@media(max-width:700px){.features-grid{grid-template-columns:1fr!important;}.features-grid>*:first-child{grid-row:auto!important;}}`}</style>
      <div style={{ borderBottom: `2px solid ${T.border}`, padding: "10px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", background: T.bgPanel, boxShadow: `0 2px 0 ${T.borderLight}` }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}><span style={{ fontFamily: T.fontVT, fontSize: 24, color: T.textPrimary, letterSpacing: 3 }}>JOB</span><span style={{ fontFamily: T.fontVT, fontSize: 24, color: T.accent, letterSpacing: 3 }}>PILOT</span></div>
        <span style={{ background: T.accentBg, border: `1px solid ${T.accent}44`, color: T.accent, borderRadius: 2, padding: "2px 10px", fontSize: 10, fontFamily: T.fontVT, letterSpacing: 1 }}>made by wendi x claude</span>
      </div>
      <div style={{ background: T.bgPanel, borderBottom: `2px solid ${T.border}`, padding: "52px 28px 44px", textAlign: "center", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: 0, backgroundImage: `linear-gradient(${T.border}33 1px,transparent 1px),linear-gradient(90deg,${T.border}33 1px,transparent 1px)`, backgroundSize: "32px 32px", pointerEvents: "none" }} />
        <div style={{ position: "relative", animation: "fadeUp .5s ease both" }}>
          <div style={{ fontFamily: T.fontVT, fontSize: 13, color: T.accent, letterSpacing: 4, marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}><span style={{ animation: "blink 1.2s infinite" }}>█</span> AI-POWERED APPLICATION ASSISTANT (v4.1) <span style={{ animation: "blink 1.2s infinite", animationDelay: ".6s" }}>█</span></div>
          <h1 style={{ fontFamily: T.fontVT, fontSize: "clamp(48px,10vw,80px)", color: T.textPrimary, margin: "0 0 10px", letterSpacing: 6, lineHeight: 1 }}>JOB<span style={{ color: T.accent }}>PILOT</span><span style={{ color: T.accent, fontSize: "clamp(20px,4vw,34px)", verticalAlign: "super", letterSpacing: 2 }}> beta</span></h1>
          <p style={{ fontFamily: T.fontMono, fontSize: 13, color: T.textMuted, maxWidth: 540, margin: "0 auto 28px", lineHeight: 1.8 }}><strong>Your job search command center... with an edge.</strong><br />Built by, and for, human professionals<br />navigating an ever-evolving job market.</p>
          <button className="enterbtn" onClick={handleLaunch} style={{ background: T.accent, color: "#fff", border: `2px solid ${T.accentLight}`, borderRadius: 2, padding: "13px 38px", fontSize: 18, fontFamily: T.fontVT, letterSpacing: 3, cursor: "pointer", boxShadow: "3px 3px 0 #1e4060", transition: "all .15s" }}>[ GET STARTED → ]</button>
        </div>
      </div>
      <div style={{ padding: "40px 28px 0", maxWidth: 900, margin: "0 auto", width: "100%" }}>
        <div style={{ fontFamily: T.fontVT, fontSize: 22, color: T.textPrimary, letterSpacing: 2, marginBottom: 4 }}>HOW IT WORKS</div>
        <div style={{ fontFamily: T.fontMono, fontSize: 11, color: T.textMuted, marginBottom: 24, lineHeight: 1.6 }}>Five integrated modules that work together. Upload your resume once — we auto-fill your profile while AI tools help you bridge your past experience with your future potential.</div>
        <div className="features-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gridTemplateRows: "auto auto", gap: 14, marginBottom: 40 }}>
          {/* Profile card - spans 2 rows on left */}
          <div className="wcard" onClick={() => onGoToTab(features[0].tab)} style={{ gridRow: "1 / 3", background: T.bgPanel, border: `1px solid ${T.border}`, borderRadius: 3, padding: "20px 22px", boxShadow: T.shadow, transition: "all .15s", animation: "fadeUp .4s ease both", cursor: "pointer", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <span style={{ fontFamily: T.fontVT, fontSize: 28, color: T.accent }}>{features[0].icon}</span>
              <span style={{ fontFamily: T.fontVT, fontSize: 18, color: T.textPrimary, letterSpacing: 1 }}>{features[0].title.toUpperCase()}</span>
            </div>
            <p style={{ fontFamily: T.fontMono, fontSize: 12, color: T.textMuted, margin: 0, lineHeight: 1.8, flex: 1 }}>{features[0].desc}</p>
            <div style={{ marginTop: 16, padding: "12px 14px", background: T.accentBg, border: `1px solid ${T.accent}44`, borderRadius: 2 }}>
              <div style={{ fontFamily: T.fontVT, fontSize: 11, color: T.accent, letterSpacing: 1, marginBottom: 6 }}>THE FOUNDATION</div>
              <div style={{ fontFamily: T.fontMono, fontSize: 10, color: T.textMuted, lineHeight: 1.6 }}>Your background + target job descriptions = quality + quantity = how you beat the numbers game</div>
            </div>
          </div>
          {/* Other 4 cards - 2x2 grid on right */}
          {features.slice(1).map((f, i) => (
            <div key={i} className="wcard" onClick={() => onGoToTab(f.tab)} style={{ background: T.bgPanel, border: `1px solid ${T.border}`, borderRadius: 3, padding: "16px 18px", boxShadow: T.shadow, transition: "all .15s", animation: `fadeUp .4s ease ${(i + 1) * 0.06}s both`, cursor: "pointer" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span style={{ fontFamily: T.fontVT, fontSize: 20, color: T.accent }}>{f.icon}</span>
                <span style={{ fontFamily: T.fontVT, fontSize: 15, color: T.textPrimary, letterSpacing: 0.8 }}>{f.title.toUpperCase()}</span>
              </div>
              <p style={{ fontFamily: T.fontMono, fontSize: 11, color: T.textMuted, margin: 0, lineHeight: 1.7 }}>{f.desc}</p>
            </div>
          ))}
        </div>
        <div ref={quickStartRef} style={{ scrollMarginTop: 20 }}>
          <Panel style={{ marginBottom: 40, background: T.accentBg, border: `1px solid ${T.accent}55` }}>
            <div style={{ fontFamily: T.fontVT, fontSize: 16, color: T.accent, letterSpacing: 1.5, marginBottom: 12 }}>◈ QUICK START — 3 STEPS</div>
            {[["1", "Fill in your Profile", "Upload your resume (.pdf/.docx/.txt) — AI auto-extracts your experience, education, and skills into structured fields. Add as much detail as you can. Your full background powers every other tool automatically."], ["2", "Add listings in the Tracker", "Paste a job description, then use the navigation buttons to route you to the right tools, with the information auto-filled each time."], ["3", "Generate files & prep", "Open File Generator for tailored cover letters and optimized resumes. Open Interview Prep for a quick one-sheet or full personalized guide — all geared exactly toward your targeted role and built from your real background."]].map(([n, title, desc]) => <div key={n} style={{ display: "flex", gap: 14, marginBottom: 14, alignItems: "flex-start" }}><div style={{ background: T.accent, color: "#fff", borderRadius: 2, width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: T.fontVT, fontSize: 16, flexShrink: 0, marginTop: 1 }}>{n}</div><div><div style={{ fontFamily: T.fontVT, fontSize: 14, color: T.textPrimary, letterSpacing: 0.8, marginBottom: 3 }}>{title}</div><div style={{ fontFamily: T.fontMono, fontSize: 11, color: T.textMuted, lineHeight: 1.65 }}>{desc}</div></div></div>)}
            <button className="enterbtn" onClick={onGetStarted} style={{ background: T.accent, color: "#fff", border: `1px solid ${T.accentLight}`, borderRadius: 2, padding: "9px 24px", fontSize: 14, fontFamily: T.fontVT, letterSpacing: 2, cursor: "pointer", boxShadow: T.shadow, marginTop: 4, transition: "background .15s" }}>[ LAUNCH APP → ]</button>
          </Panel>
        </div>
      </div>
      <div style={{ padding: "20px 28px 14px", maxWidth: 900, margin: "0 auto", width: "100%", textAlign: "center" }}>
        <div style={{ fontFamily: T.fontMono, fontSize: 10, color: T.textFaint, marginBottom: 8 }}>Your data stays private — nothing is stored on any server.</div>
        <div style={{ fontFamily: T.fontMono, fontSize: 9, color: T.textFaint, lineHeight: 1.6, marginBottom: 8 }}>
          By using this app, you agree to our <a href="#terms" onClick={(e) => { e.preventDefault(); onShowTerms(); }} style={{ color: T.accent, textDecoration: "underline", cursor: "pointer" }}>Terms of Service</a>.
        </div>
        <div style={{ fontFamily: T.fontMono, fontSize: 9, color: T.textFaint, fontStyle: "italic" }}>AI-generated content is not guaranteed to be accurate and should be double-checked before use.</div>
      </div>
      <div style={{ borderTop: `1px solid ${T.border}`, padding: "14px 28px", display: "flex", justifyContent: "space-between", alignItems: "center", background: T.bgPanel, marginTop: "auto", flexWrap: "wrap", gap: 8 }}>
        <span style={{ fontFamily: T.fontVT, fontSize: 14, color: T.textFaint, letterSpacing: 2 }}>JOBPILOT (v4.1)</span>
        <span style={{ fontFamily: T.fontMono, fontSize: 10, color: T.textFaint }}>made by wendi x claude · AI-powered</span>
      </div>
    </div>
  );
}

// ── TERMS OF SERVICE PAGE ────────────────────────────────────────────────────
function TermsPage({ onBack }) {
  return (
    <div style={{ minHeight: "100vh", background: T.bg, display: "flex", flexDirection: "column" }}>
      <link href="https://fonts.googleapis.com/css2?family=VT323&display=swap" rel="stylesheet" />
      <div style={{ borderBottom: `2px solid ${T.border}`, padding: "10px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", background: T.bgPanel, boxShadow: `0 2px 0 ${T.borderLight}` }}>
        <div onClick={onBack} style={{ display: "flex", alignItems: "baseline", gap: 10, cursor: "pointer" }}>
          <span style={{ fontFamily: T.fontVT, fontSize: 24, color: T.textPrimary, letterSpacing: 3 }}>JOB</span>
          <span style={{ fontFamily: T.fontVT, fontSize: 24, color: T.accent, letterSpacing: 3 }}>PILOT</span>
        </div>
        <button onClick={onBack} style={{ background: T.accentBg, border: `1px solid ${T.accent}44`, color: T.accent, borderRadius: 2, padding: "4px 12px", fontSize: 11, fontFamily: T.fontVT, letterSpacing: 1, cursor: "pointer" }}>← BACK TO HOME</button>
      </div>
      <div style={{ padding: "40px 28px", maxWidth: 800, margin: "0 auto", width: "100%", flex: 1 }}>
        <h1 style={{ fontFamily: T.fontVT, fontSize: 32, color: T.textPrimary, letterSpacing: 2, marginBottom: 4 }}>JOBPILOT</h1>
        <h2 style={{ fontFamily: T.fontVT, fontSize: 22, color: T.accent, letterSpacing: 1, marginBottom: 8 }}>Terms of Service</h2>
        <p style={{ fontFamily: T.fontMono, fontSize: 11, color: T.textFaint, marginBottom: 28 }}><em>Effective Date: March 31, 2026</em></p>
        
        <div style={{ fontFamily: T.fontMono, fontSize: 12, color: T.textMuted, lineHeight: 1.8 }}>
          <p style={{ marginBottom: 16 }}>Welcome to JobPilot ("Service," "App," or "we"). By accessing or using JobPilot, you agree to be bound by these Terms of Service ("Terms"). Please read them carefully before using the Service.</p>
          
          <h3 style={{ fontFamily: T.fontVT, fontSize: 16, color: T.textPrimary, letterSpacing: 1, marginTop: 28, marginBottom: 12 }}>1. DESCRIPTION OF SERVICE</h3>
          <p style={{ marginBottom: 12 }}>JobPilot is an AI-powered job application assistant that provides tools including:</p>
          <ul style={{ marginLeft: 20, marginBottom: 16 }}>
            <li>Profile and resume management with AI-assisted data extraction</li>
            <li>Job application tracking and organization</li>
            <li>AI-generated cover letters and resume optimization</li>
            <li>Interview preparation guidance</li>
            <li>Career development resources and AI-powered recommendations</li>
          </ul>
          
          <h3 style={{ fontFamily: T.fontVT, fontSize: 16, color: T.textPrimary, letterSpacing: 1, marginTop: 28, marginBottom: 12 }}>2. ACCEPTANCE OF TERMS</h3>
          <p style={{ marginBottom: 16 }}>By using JobPilot, you acknowledge that you have read, understood, and agree to be bound by these Terms. If you do not agree to these Terms, you must not use the Service. We reserve the right to modify these Terms at any time. Your continued use of the Service after any changes constitutes acceptance of the modified Terms.</p>
          
          <h3 style={{ fontFamily: T.fontVT, fontSize: 16, color: T.textPrimary, letterSpacing: 1, marginTop: 28, marginBottom: 12 }}>3. DATA STORAGE AND PRIVACY</h3>
          <p style={{ marginBottom: 12 }}><strong>3.1 Local Data Storage</strong></p>
          <p style={{ marginBottom: 12 }}>JobPilot stores your data locally on your device using browser-based storage mechanisms. Your personal information, resume content, job applications, and other data you enter are stored on your device and are not transmitted to or stored on our servers.</p>
          <p style={{ marginBottom: 12 }}><strong>3.2 AI Processing</strong></p>
          <p style={{ marginBottom: 12 }}>When you use AI-powered features (such as generating cover letters, extracting resume data, or interview preparation), your data is transmitted to Anthropic's Claude API for processing. This data is processed in accordance with Anthropic's privacy policy and data handling practices. We do not retain copies of data sent to or received from the AI service.</p>
          <p style={{ marginBottom: 12 }}><strong>3.3 Your Responsibility</strong></p>
          <p style={{ marginBottom: 16 }}>You are solely responsible for backing up your data. Data stored locally on your device may be lost if you clear your browser data, use incognito/private browsing, or experience device failure. We are not responsible for any data loss.</p>
          
          <h3 style={{ fontFamily: T.fontVT, fontSize: 16, color: T.textPrimary, letterSpacing: 1, marginTop: 28, marginBottom: 12 }}>4. LIMITATION OF LIABILITY</h3>
          <p style={{ marginBottom: 12 }}><strong>4.1 No Guarantees</strong></p>
          <p style={{ marginBottom: 12, textTransform: "uppercase", fontSize: 11 }}>JobPilot is provided "as is" and "as available" without warranties of any kind, either express or implied. We do not warrant that the service will be uninterrupted, error-free, or secure, or that any defects will be corrected.</p>
          <p style={{ marginBottom: 12 }}><strong>4.2 No Employment Guarantees</strong></p>
          <p style={{ marginBottom: 12 }}>JobPilot is a tool to assist with your job search. We do not guarantee that using the Service will result in job interviews, job offers, or employment. The effectiveness of AI-generated content may vary based on numerous factors outside our control, including employer preferences, market conditions, and individual qualifications.</p>
          <p style={{ marginBottom: 12 }}><strong>4.3 AI Content Limitations</strong></p>
          <p style={{ marginBottom: 12 }}>AI-generated content (including cover letters, resume suggestions, and interview preparation materials) is provided as a starting point and should be reviewed, edited, and verified by you before use. AI outputs may contain errors, inaccuracies, or content that is not suitable for your specific situation.</p>
          <p style={{ marginBottom: 12, textTransform: "uppercase", fontSize: 11, background: T.amberBg, padding: 12, border: `1px solid ${T.amber}44`, borderRadius: 2 }}>YOU ARE SOLELY RESPONSIBLE FOR REVIEWING AND VERIFYING ALL AI-GENERATED CONTENT BEFORE SUBMITTING IT TO EMPLOYERS OR USING IT IN ANY PROFESSIONAL CONTEXT.</p>
          <p style={{ marginBottom: 12 }}><strong>4.4 Exclusion of Damages</strong></p>
          <p style={{ marginBottom: 12 }}>To the maximum extent permitted by applicable law, in no event shall JobPilot, its creators, developers, or affiliates be liable for any indirect, incidental, special, consequential, or punitive damages, including but not limited to:</p>
          <ul style={{ marginLeft: 20, marginBottom: 16 }}>
            <li>Loss of employment opportunities</li>
            <li>Rejection from job applications</li>
            <li>Lost income or wages</li>
            <li>Damage to professional reputation</li>
            <li>Loss of data or inability to access data</li>
            <li>Errors or inaccuracies in AI-generated content</li>
            <li>Any other damages arising from your use of the Service</li>
          </ul>
          
          <h3 style={{ fontFamily: T.fontVT, fontSize: 16, color: T.textPrimary, letterSpacing: 1, marginTop: 28, marginBottom: 12 }}>5. USER RESPONSIBILITIES</h3>
          <p style={{ marginBottom: 12 }}><strong>5.1 Accuracy of Information</strong></p>
          <p style={{ marginBottom: 12 }}>You are responsible for the accuracy, truthfulness, and completeness of all information you provide to the Service. You agree not to use the Service to create false, misleading, or fraudulent job application materials.</p>
          <p style={{ marginBottom: 12 }}><strong>5.2 Review of AI Output</strong></p>
          <p style={{ marginBottom: 12 }}>You acknowledge that AI-generated content requires human review and editing. You agree to carefully review all AI-generated content before using it and to take full responsibility for any content you submit to employers or publish.</p>
          <p style={{ marginBottom: 12 }}><strong>5.3 Lawful Use</strong></p>
          <p style={{ marginBottom: 16 }}>You agree to use the Service only for lawful purposes and in compliance with all applicable laws, including employment laws, anti-discrimination laws, and data protection regulations.</p>
          
          <h3 style={{ fontFamily: T.fontVT, fontSize: 16, color: T.textPrimary, letterSpacing: 1, marginTop: 28, marginBottom: 12 }}>6. INTELLECTUAL PROPERTY</h3>
          <p style={{ marginBottom: 12 }}><strong>6.1 Your Content</strong></p>
          <p style={{ marginBottom: 12 }}>You retain all rights to the personal information, resume content, and other materials you input into the Service. By using the AI features, you grant us a limited, non-exclusive license to process your data for the purpose of providing the Service.</p>
          <p style={{ marginBottom: 12 }}><strong>6.2 AI-Generated Content</strong></p>
          <p style={{ marginBottom: 16 }}>AI-generated content created through the Service may be used by you for personal and professional purposes, including job applications. However, we make no representations regarding the copyright status of AI-generated content, and you assume all risk associated with its use.</p>
          
          <h3 style={{ fontFamily: T.fontVT, fontSize: 16, color: T.textPrimary, letterSpacing: 1, marginTop: 28, marginBottom: 12 }}>7. THIRD-PARTY SERVICES</h3>
          <p style={{ marginBottom: 16 }}>JobPilot integrates with third-party services, including Anthropic's Claude API for AI functionality. Your use of these services is subject to their respective terms of service and privacy policies. We are not responsible for the availability, accuracy, or performance of third-party services.</p>
          
          <h3 style={{ fontFamily: T.fontVT, fontSize: 16, color: T.textPrimary, letterSpacing: 1, marginTop: 28, marginBottom: 12 }}>8. INDEMNIFICATION</h3>
          <p style={{ marginBottom: 16 }}>You agree to indemnify, defend, and hold harmless JobPilot, its creators, developers, and affiliates from and against any and all claims, liabilities, damages, losses, costs, and expenses (including reasonable attorneys' fees) arising out of or relating to: (a) your use of the Service; (b) your violation of these Terms; (c) your violation of any third-party rights; (d) any content you submit to the Service; or (e) your use of AI-generated content.</p>
          
          <h3 style={{ fontFamily: T.fontVT, fontSize: 16, color: T.textPrimary, letterSpacing: 1, marginTop: 28, marginBottom: 12 }}>9. BETA STATUS DISCLAIMER</h3>
          <p style={{ marginBottom: 16 }}>JobPilot is currently in beta. This means the Service may contain bugs, errors, or other issues that could affect functionality. Features may change, be modified, or be removed at any time without notice. By using the beta version, you acknowledge and accept these limitations and agree that the Service is provided for testing and feedback purposes.</p>
          
          <h3 style={{ fontFamily: T.fontVT, fontSize: 16, color: T.textPrimary, letterSpacing: 1, marginTop: 28, marginBottom: 12 }}>10. TERMINATION</h3>
          <p style={{ marginBottom: 16 }}>We reserve the right to suspend or terminate your access to the Service at any time, for any reason, without notice. Since your data is stored locally on your device, termination of the Service does not affect your locally stored data, though you will no longer be able to use the Service to process it.</p>
          
          <h3 style={{ fontFamily: T.fontVT, fontSize: 16, color: T.textPrimary, letterSpacing: 1, marginTop: 28, marginBottom: 12 }}>11. GOVERNING LAW AND DISPUTE RESOLUTION</h3>
          <p style={{ marginBottom: 16 }}>These Terms shall be governed by and construed in accordance with the laws of the State of California, United States, without regard to its conflict of law provisions. Any disputes arising from these Terms or your use of the Service shall be resolved through binding arbitration in accordance with the rules of the American Arbitration Association.</p>
          
          <h3 style={{ fontFamily: T.fontVT, fontSize: 16, color: T.textPrimary, letterSpacing: 1, marginTop: 28, marginBottom: 12 }}>12. SEVERABILITY</h3>
          <p style={{ marginBottom: 16 }}>If any provision of these Terms is found to be invalid or unenforceable, the remaining provisions shall continue in full force and effect. The invalid or unenforceable provision shall be modified to the minimum extent necessary to make it valid and enforceable.</p>
          
          <h3 style={{ fontFamily: T.fontVT, fontSize: 16, color: T.textPrimary, letterSpacing: 1, marginTop: 28, marginBottom: 12 }}>13. ENTIRE AGREEMENT</h3>
          <p style={{ marginBottom: 16 }}>These Terms constitute the entire agreement between you and JobPilot regarding the use of the Service and supersede all prior or contemporaneous communications, representations, or agreements, whether oral or written.</p>
          
          <h3 style={{ fontFamily: T.fontVT, fontSize: 16, color: T.textPrimary, letterSpacing: 1, marginTop: 28, marginBottom: 12 }}>14. CONTACT INFORMATION</h3>
          <p style={{ marginBottom: 28 }}>If you have any questions about these Terms or the Service, please contact us through the official channels provided within the application.</p>
          
          <div style={{ background: T.accentBg, padding: 16, border: `1px solid ${T.accent}44`, borderRadius: 2, marginTop: 28, marginBottom: 16, textAlign: "center" }}>
            <p style={{ margin: 0, fontWeight: "bold", textTransform: "uppercase", fontSize: 11 }}>BY USING JOBPILOT, YOU ACKNOWLEDGE THAT YOU HAVE READ, UNDERSTOOD, AND AGREE TO BE BOUND BY THESE TERMS OF SERVICE.</p>
          </div>
          
          <p style={{ fontStyle: "italic", color: T.textFaint, fontSize: 11, textAlign: "center" }}>Last Updated: March 31, 2026</p>
        </div>
      </div>
      <div style={{ borderTop: `1px solid ${T.border}`, padding: "14px 28px", display: "flex", justifyContent: "space-between", alignItems: "center", background: T.bgPanel, flexWrap: "wrap", gap: 8 }}>
        <span style={{ fontFamily: T.fontVT, fontSize: 14, color: T.textFaint, letterSpacing: 2 }}>JOBPILOT (v4.1)</span>
        <span style={{ fontFamily: T.fontMono, fontSize: 10, color: T.textFaint }}>made by wendi x claude · AI-powered</span>
      </div>
    </div>
  );
}

// ── AVATAR PICKER — multi-select ─────────────────────────────────────────────
const AVATARS = [
  { id: "strategist", emoji: "🧠", label: "Strategist" },
  { id: "creative",   emoji: "🎨", label: "Creative" },
  { id: "builder",    emoji: "🔧", label: "Builder" },
  { id: "analyst",    emoji: "📊", label: "Analyst" },
  { id: "storyteller",emoji: "💡", label: "Storyteller" },
  { id: "connector",  emoji: "🌐", label: "Connector" },
  { id: "cultivator", emoji: "🌱", label: "Cultivator" },
  { id: "explorer",   emoji: "🚀", label: "Explorer" },
  { id: "operator",   emoji: "🎯", label: "Operator" },
];

function AvatarPicker({ profile, setProfile }) {
  // Support multi-select: avatars stored as array
  const selected = Array.isArray(profile.avatars) ? profile.avatars : (profile.avatar ? [profile.avatar] : []);
  const toggle = (id) => {
    const next = selected.includes(id) ? selected.filter(a => a !== id) : [...selected, id];
    setProfile(p => ({ ...p, avatars: next, avatar: next[0] || "" }));
  };
  return (
    <div style={{ display: "flex", gap: 14, marginBottom: 4, alignItems: "flex-start" }}>
      <div style={{ flexShrink: 0 }}>
        <div style={{ height: 19, marginBottom: 5 }} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 4, width: 108 }}>
          {AVATARS.map(a => {
            const isSelected = selected.includes(a.id);
            return (
              <button key={a.id} onClick={() => toggle(a.id)}
                title={a.label}
                style={{ width: 32, height: 32, border: `1px solid ${isSelected ? T.accent : T.border}`, borderRadius: 2, background: isSelected ? T.accentBg : T.bgInset, cursor: "pointer", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center", padding: 0, boxShadow: isSelected ? `0 0 0 1px ${T.accent}` : "none", transition: "all .1s" }}>
                {a.emoji}
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ flex: 1 }}>
        <TextInput label="Name" value={profile.name || ""} onChange={v => setProfile(p => ({ ...p, name: v }))} placeholder="First Last" />
        <div style={{ color: selected.length > 0 ? T.accent : T.textFaint, fontSize: 9, fontFamily: T.fontVT, letterSpacing: 1.5, marginTop: 4 }}>
          {selected.length > 0
            ? selected.map(id => (AVATARS.find(a => a.id === id) || {}).label || "").join(" · ").toUpperCase()
            : "ARCHETYPE"}
        </div>
      </div>
    </div>
  );
}

// ── TAB 1: PROFILE ───────────────────────────────────────────────────────────
const ProfileTab = memo(function ProfileTab({ profile, setProfile }) {
  const fileRef = useRef();
  const coverFileRef = useRef();
  const [saved, setSaved] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [parseStatus, setParseStatus] = useState("");

  const handleResumeFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    // Reset input so the same file can be re-uploaded if parsing fails
    e.target.value = "";
    setParsing(true);
    setParseStatus("Reading file...");
    
    // PERFORMANCE FIX: Yield to event loop so UI can update
    await new Promise(resolve => setTimeout(resolve, 50));
    
    try {
      const text = await parseFile(file);
      setParseStatus("Extracting resume data with AI — this takes ~10 seconds...");
      
      // PERFORMANCE FIX: Yield again before long API call
      await new Promise(resolve => setTimeout(resolve, 50));
      
      try {
        const parsed = await callClaude(
          `You parse resume text into structured JSON. Return ONLY valid JSON, no markdown, no backticks.`,
          `Parse this resume into JSON with these exact keys: name (string), summary (string, 2-4 sentences), keywords (comma-separated skills string), experience (array of {role, company, dates, details} — details max 3 bullet points as plain text separated by \\n), education (array of {degree, areaOfStudy, school, dates}), strengths (string, notable strengths not covered above).\n\nResume:\n${text.slice(0, 6000)}`
        );
        const clean = parsed.replace(/```json|```/g, "").trim();
        const data = JSON.parse(clean);
        setParseStatus("Filling fields...");
        
        // PERFORMANCE FIX: Yield before updating profile
        await new Promise(resolve => setTimeout(resolve, 50));
        
        setProfile(p => ({
          ...p,
          resumeFileName: file.name,
          name: data.name || p.name,
          summary: data.summary || p.summary,
          keywords: data.keywords || p.keywords,
          experience: data.experience?.length ? data.experience : p.experience,
          education: data.education?.length ? data.education : p.education,
          strengths: data.strengths || p.strengths,
        }));
      } catch {
        setParseStatus("Filling fields...");
        await new Promise(resolve => setTimeout(resolve, 50));
        setProfile(p => ({ ...p, summary: text.slice(0, 2000), resumeFileName: file.name }));
      }
    } catch {
      setParsing(false);
      setParseStatus("");
      alert("Could not read file — try a different format.");
      return;
    }
    setParsing(false);
    setParseStatus("");
  };

  const handleCoverFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await parseFile(file);
      setProfile(p => ({ ...p, coverTemplate: text, coverFileName: file.name }));
    } catch { alert("Could not read file — try a different format or paste the text below."); }
  };

  const addExperience = () => setProfile(p => ({ ...p, experience: [...(p.experience || []), { role: "", company: "", dates: "", details: "" }] }));
  const removeExperience = (i) => setProfile(p => ({ ...p, experience: p.experience.filter((_, j) => j !== i) }));
  const updateExp = (i, field, val) => setProfile(p => ({ ...p, experience: p.experience.map((e, j) => j === i ? { ...e, [field]: val } : e) }));

  const addEducation = () => setProfile(p => ({ ...p, education: [...(p.education || []), { degree: "", areaOfStudy: "", school: "", dates: "" }] }));
  const removeEducation = (i) => setProfile(p => ({ ...p, education: p.education.filter((_, j) => j !== i) }));
  const updateEdu = (i, field, val) => setProfile(p => ({ ...p, education: p.education.map((e, j) => j === i ? { ...e, [field]: val } : e) }));

  return (
    <div>
      <SectionTitle>Job Seeker Profile</SectionTitle>
      <SectionSub>Fill this in once — the AI tools will use this information as context for all future output.</SectionSub>

      {/* Upload to auto-fill */}
      <div id="resume-upload-box" style={{ scrollMarginTop: 20 }}>
        <Panel style={{ background: profile.resumeFileName ? T.accentBg : T.amberBg, border: `1px solid ${profile.resumeFileName ? T.accent : T.amber}55`, marginBottom: 20 }}>
          <FieldLabel>Resume * (required)</FieldLabel>
          <input ref={fileRef} type="file" accept=".txt,.md,.text,.pdf,.docx" onChange={handleResumeFile} style={{ display: "none" }} />
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <Btn onClick={() => !parsing && fileRef.current.click()} loading={parsing} label="[ UPLOAD RESUME (.pdf / .docx / .txt) ]" variant="ghost" small />
            {parsing
              ? <span style={{ fontSize: 11, fontFamily: T.fontMono, color: T.accent, display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ animation: "blink 1s infinite" }}>█</span> {parseStatus}
                </span>
              : profile.resumeFileName
                ? <span style={{ fontSize: 11, fontFamily: T.fontMono, color: T.green }}>✓ {profile.resumeFileName} — fields auto-filled below</span>
                : <span style={{ fontSize: 11, fontFamily: T.fontMono, color: T.amber }}>⚠ Upload your resume to enable all AI features</span>}
          </div>
        </Panel>
      </div>

      {/* Name + Avatar */}
      <AvatarPicker profile={profile} setProfile={setProfile} />

      {/* Skills & Keywords right under Name — same size as Summary */}
      <div style={{ marginTop: 16 }} />
      <TextArea label="Skills & Keywords (comma-separated)" value={profile.keywords || ""} onChange={v => setProfile(p => ({ ...p, keywords: v }))} rows={3} placeholder="Brand Strategy, Campaign Management, Adobe Suite, HubSpot, SEO..." />

      <div className="grid-2" style={{ marginBottom: 4 }}>
        <TextInput label="LinkedIn URL" value={profile.linkedin || ""} onChange={v => setProfile(p => ({ ...p, linkedin: v }))} placeholder="https://linkedin.com/in/yourname" />
        <TextInput label="Website / Portfolio URL" value={profile.portfolio || ""} onChange={v => setProfile(p => ({ ...p, portfolio: v }))} placeholder="https://yoursite.com" />
      </div>

      {/* Summary */}
      <TextArea label="Professional Summary" value={profile.summary || ""} onChange={v => setProfile(p => ({ ...p, summary: v }))} rows={3} placeholder="2–4 sentence professional summary..." />

      {/* Experience */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <FieldLabel>Experience</FieldLabel>
          <Btn onClick={addExperience} label="+ ADD ROLE" small variant="ghost" />
        </div>
        {(profile.experience || []).map((exp, i) => (
          <div key={i} style={{ background: T.bgInset, border: `1px solid ${T.border}`, borderRadius: 2, padding: "12px 14px", marginBottom: 10 }}>
            <div className="grid-2" style={{ gap: 10, marginBottom: 8 }}>
              <TextInput label="Job Title / Role" value={exp.role || ""} onChange={v => updateExp(i, "role", v)} placeholder="Marketing Manager" />
              <TextInput label="Company" value={exp.company || ""} onChange={v => updateExp(i, "company", v)} placeholder="Company Name" />
            </div>
            <div style={{ marginBottom: 8 }}>
              <TextInput label="Dates" value={exp.dates || ""} onChange={v => updateExp(i, "dates", v)} placeholder="Jan 2021 – Present" />
            </div>
            <TextArea label="Details / Bullet Points" value={exp.details || ""} onChange={v => updateExp(i, "details", v)} rows={3} placeholder="Key responsibilities and achievements..." />
            {(profile.experience || []).length > 1 && (
              <button onClick={() => removeExperience(i)} style={{ background: T.redBg, border: `1px solid ${T.red}55`, borderRadius: 2, color: T.red, fontSize: 11, fontFamily: T.fontVT, padding: "2px 8px", cursor: "pointer" }}>✕ REMOVE</button>
            )}
          </div>
        ))}
      </div>

      {/* Education — with Area of Study field */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <FieldLabel>Education</FieldLabel>
          <Btn onClick={addEducation} label="+ ADD" small variant="ghost" />
        </div>
        {(profile.education || []).map((edu, i) => (
          <div key={i} style={{ background: T.bgInset, border: `1px solid ${T.border}`, borderRadius: 2, padding: "12px 14px", marginBottom: 10 }}>
            <div className="grid-2" style={{ gap: 10 }}>
              <TextInput label="Degree / Certification" value={edu.degree || ""} onChange={v => updateEdu(i, "degree", v)} placeholder="B.S. Marketing" />
              <TextInput label="School / Institution" value={edu.school || ""} onChange={v => updateEdu(i, "school", v)} placeholder="University of Texas" />
            </div>
            <div className="grid-2" style={{ gap: 10 }}>
              <TextInput label="Area of Study" value={edu.areaOfStudy || ""} onChange={v => updateEdu(i, "areaOfStudy", v)} placeholder="e.g. Marketing, Design, Communications..." />
              <TextInput label="Dates" value={edu.dates || ""} onChange={v => updateEdu(i, "dates", v)} placeholder="2016 – 2020" />
            </div>
            {(profile.education || []).length > 1 && (
              <button onClick={() => removeEducation(i)} style={{ background: T.redBg, border: `1px solid ${T.red}55`, borderRadius: 2, color: T.red, fontSize: 11, fontFamily: T.fontVT, padding: "2px 8px", cursor: "pointer" }}>✕ REMOVE</button>
            )}
          </div>
        ))}
      </div>

      {/* Additional Strengths */}
      <TextArea label="Additional Strengths" value={profile.strengths || ""} onChange={v => setProfile(p => ({ ...p, strengths: v }))} rows={2} placeholder="Soft skills, certifications, languages, tools, notable traits..." />

      {/* Cover Letter Template */}
      <div style={{ marginBottom: 14, marginTop: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
          <FieldLabel>Custom Cover Letter (paste or upload a style sample)</FieldLabel>
        </div>
        <input ref={coverFileRef} type="file" accept=".txt,.md,.text,.pdf,.docx" onChange={handleCoverFile} style={{ display: "none" }} />
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8 }}>
          <Btn onClick={() => coverFileRef.current.click()} label="[ UPLOAD FILE (.pdf / .docx / .txt) ]" variant="ghost" small />
          {profile.coverFileName
            ? <span style={{ fontSize: 11, fontFamily: T.fontMono, color: T.green }}>✓ {profile.coverFileName}</span>
            : <span style={{ fontSize: 11, fontFamily: T.fontMono, color: T.textFaint }}>or paste below</span>}
        </div>
        <TextArea value={profile.coverTemplate || ""} onChange={v => setProfile(p => ({ ...p, coverTemplate: v, coverFileName: "" }))} rows={4} placeholder="Paste a cover letter you like as a tone/style reference..." />
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Btn onClick={async () => {
            try { localStorage.setItem("profile", JSON.stringify(profile)); } catch {}
            setSaved(true); setTimeout(() => setSaved(false), 2000);
          }} label={saved ? "✓ SAVED" : "[ SAVE PROFILE ]"} variant={saved ? "ghost" : "primary"} />
          {saved && <span style={{ color: T.green, fontSize: 11, fontFamily: T.fontMono }}>Profile saved.</span>}
        </div>
        <button onClick={() => {
          const clearedProfile = {
            ...profile,
            name: "", summary: "", keywords: "", strengths: "", linkedin: "", portfolio: "",
            resume: "", resumeFileName: "", coverTemplate: "", coverFileName: "", avatar: "", avatars: [],
            savedRoles: [], savedIndustries: [],
            experience: [{ role: "", company: "", dates: "", details: "" }],
            education: [{ degree: "", areaOfStudy: "", school: "", dates: "" }],
          };
          setProfile(clearedProfile);
          try { localStorage.setItem("profile", JSON.stringify(clearedProfile)); } catch {}
        }} style={{ background: T.redBg, color: T.red, border: `1px solid ${T.red}55`, borderRadius: 2, padding: "5px 12px", fontSize: 11, fontFamily: T.fontVT, letterSpacing: 0.8, cursor: "pointer", boxShadow: T.shadow, whiteSpace: "nowrap" }}>[ CLEAR ALL ]</button>
      </div>

      <Panel style={{ background: T.greenBg, border: `1px solid ${T.green}55` }}>
        <span style={{ color: T.green, fontFamily: T.fontVT, fontSize: 13, letterSpacing: 0.5 }}>
          ✓ PROFILE ACTIVE — All AI tabs reference your full experience, roles, and industries automatically.
        </span>
      </Panel>
    </div>
  );
});

// ── JOB SOURCES ──────────────────────────────────────────────────────────────


const TrackerTab = memo(function TrackerTab({ profile, setActiveTab, setFileGenJob, setInterviewJob }) {
  const [cards, setCards] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({ company: "", role: "", link: "", compensation: "", location: "", jobType: "", jd: "", notes: "", status: "Saved" });
  const [prefilling, setPrefilling] = useState(false);
  const [newRow, setNewRow] = useState({ company: "", role: "", compensation: "", location: "", jobType: "", status: "Saved" });
  const uploadRef = useRef();

  // Company autocomplete state
  const [companyFocused, setCompanyFocused] = useState(false);
  const companyRef = useRef(null);

  // Get unique company names from existing cards for autocomplete
  const existingCompanies = [...new Set(cards.map(c => c.company).filter(Boolean))];
  const companyMatches = form.company.trim().length > 0
    ? existingCompanies.filter(c => c.toLowerCase().includes(form.company.toLowerCase()) && c !== form.company).slice(0, 6)
    : [];

  useEffect(() => {
    const handler = (e) => { if (companyRef.current && !companyRef.current.contains(e.target)) setCompanyFocused(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const result = localStorage.getItem("tracker-cards");
        if (result) setCards(JSON.parse(result));
      } catch {}
      setLoaded(true);
    })();
  }, []);

  // PERFORMANCE FIX: Debounced storage for tracker cards
  useDebouncedStorage("tracker-cards", loaded ? cards : null, 500);

  const prefillFromUrl = async () => {
    const url = form.link.trim();
    if (!url) return;
    setPrefilling(true);
    
    // PERFORMANCE FIX: Yield to let UI update
    await new Promise(resolve => setTimeout(resolve, 50));
    
    let pageText = "";
    try {
      const res = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`);
      const data = await res.json();
      const html = data.contents || "";
      if (html) {
        pageText = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000);
      }
    } catch {}
    if (!pageText) {
      try {
        const res = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`);
        const html = await res.text();
        if (html) pageText = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000);
      } catch {}
    }
    
    try {
      // Step 1: extract from URL/page
      const prompt = pageText
        ? `Extract job listing info from this page content:\n\n${pageText}`
        : `Extract job info from this URL: ${url}`;
        
      // PERFORMANCE FIX: Yield before first AI call
      await new Promise(resolve => setTimeout(resolve, 50));
      
      const result = await callClaude(
        `You extract job listing details. Return ONLY a valid JSON object with keys: company, role, compensation, location, jobType (Remote/Hybrid/On-site or empty), notes (first 400 chars of JD). No markdown.`,
        prompt
      );
      const cleaned = result.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      let merged = {
        company: parsed.company || "",
        role: parsed.role || "",
        compensation: parsed.compensation || "",
        location: parsed.location || "",
        jobType: parsed.jobType || "",
        jd: parsed.notes || "",
      };
      // Step 2: if JD is pasted, override with data extracted from it
      const jdText = form.jd.trim();
      if (jdText) {
        // PERFORMANCE FIX: Yield before second AI call
        await new Promise(resolve => setTimeout(resolve, 50));
        
        const jdResult = await callClaude(
          `You extract job listing details from a job description. Return ONLY a valid JSON object with keys: company, role, compensation, location, jobType (Remote/Hybrid/On-site or empty). No markdown.`,
          `Extract job info from this job description:\n\n${jdText.slice(0, 4000)}`
        );
        const jdCleaned = jdResult.replace(/```json|```/g, "").trim();
        const jdParsed = JSON.parse(jdCleaned);
        if (jdParsed.company) merged.company = jdParsed.company;
        if (jdParsed.role) merged.role = jdParsed.role;
        if (jdParsed.compensation) merged.compensation = jdParsed.compensation;
        if (jdParsed.location) merged.location = jdParsed.location;
        if (jdParsed.jobType) merged.jobType = jdParsed.jobType;
        merged.jd = jdText; // keep the full pasted JD
      }
      
      // PERFORMANCE FIX: Yield before updating form
      await new Promise(resolve => setTimeout(resolve, 50));
      
      setForm(f => ({
        ...f,
        company: merged.company || f.company,
        role: merged.role || f.role,
        compensation: merged.compensation || f.compensation,
        location: merged.location || f.location,
        jobType: merged.jobType || f.jobType,
        jd: merged.jd || f.jd,
      }));
    } catch { alert("Couldn't auto-extract job info — most ATS pages (Greenhouse, Lever, Workday) block scraping. Try pasting the full job description into the JD field above, then click ✦ FILL again."); }
    setPrefilling(false);
  };

  const addCard = () => {
    if (!form.role || !form.company) return;
    if (editingId) {
      setCards(c => c.map(card => card.id === editingId ? { ...card, ...form } : card));
      setEditingId(null);
    } else {
      const newCard = { ...form, id: Date.now(), date: new Date().toLocaleDateString() };
      setCards(c => [...c, newCard]);
      if (form.status === "Applied") { setFileGenJob({ company: form.company, role: form.role, jd: form.jd || "", notes: form.notes || "" }); setActiveTab("filegen"); }
      if (form.status === "Phone Screen" || form.status === "Interview") { setInterviewJob({ company: form.company, title: form.role, jd: form.jd || "", notes: form.notes || "", stage: form.status }); setActiveTab("interview"); }
    }
    setShowModal(false);
    setForm({ company: "", role: "", link: "", compensation: "", location: "", jobType: "", jd: "", notes: "", status: "Saved" });
  };

  const openEdit = (card) => {
    setForm({ company: card.company || "", role: card.role || "", link: card.link || "", compensation: card.compensation || "", location: card.location || "", jobType: card.jobType || "", jd: card.jd || "", notes: card.notes || "", status: card.status || "Saved" });
    setEditingId(card.id);
    setShowModal(true);
  };

  const updateCardField = (id, field, value) => {
    const now = new Date().toLocaleDateString();
    setCards(c => c.map(card => card.id === id ? { ...card, [field]: value, date: field === "date" ? card.date : now } : card));
    if (field === "status") {
      const card = cards.find(c => c.id === id);
      if (!card) return;
      if (value === "Applied") { setFileGenJob({ company: card.company, role: card.role, jd: card.jd || "", notes: card.notes || "" }); setActiveTab("filegen"); }
      if (value === "Phone Screen" || value === "Interview") { setInterviewJob({ company: card.company, title: card.role, jd: card.jd || "", notes: card.notes || "", stage: value }); setActiveTab("interview"); }
    }
  };

  const delCard = (id) => setCards(c => c.filter(card => card.id !== id));

  const commitNewRow = () => {
    if (!newRow.company && !newRow.role) return;
    const now = new Date().toLocaleDateString();
    setCards(c => [...c, { ...newRow, id: Date.now(), date: now, jd: "", notes: "", link: "" }]);
    setNewRow({ company: "", role: "", compensation: "", location: "", jobType: "", status: "Saved" });
  };

  const uploadSpreadsheet = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const ext = file.name.split(".").pop().toLowerCase();
    const now = new Date().toLocaleDateString();
    try {
      if (ext === "csv") {
        const text = await file.text();
        const lines = text.split("\n").filter(l => l.trim());
        const headers = lines[0].split(",").map(h => h.replace(/"/g, "").trim().toLowerCase());
        const rows = lines.slice(1).map(line => {
          const vals = line.match(/(".*?"|[^,]+)(?=,|$)/g) || [];
          const obj = {};
          headers.forEach((h, i) => { obj[h] = (vals[i] || "").replace(/^"|"$/g, "").trim(); });
          return obj;
        });
        const newCards = rows.filter(r => r.company || r.role).map(r => ({
          id: Date.now() + Math.random(), company: r.company || "", role: r.role || "", status: r.status || "Saved",
          compensation: r.compensation || r.comp || "", location: r.location || "",
          jobType: r["job type"] || r.jobtype || "", link: r.link || r.url || "",
          jd: r["job description"] || r.jd || r.description || "", notes: r.notes || "", date: r.date || now,
        }));
        setCards(c => [...c, ...newCards]);
      }
    } catch { alert("Couldn't parse file — try a .csv export."); }
    e.target.value = "";
  };

  const applied = cards.filter(c => !["Saved", "Pending"].includes(c.status)).length;
  const inProgress = cards.filter(c => ["Applied", "Phone Screen", "Interview"].includes(c.status)).length;

  const getMonthKey = (dateStr) => {
    if (!dateStr) return "Unknown";
    const d = new Date(dateStr);
    if (isNaN(d)) return dateStr;
    return d.toLocaleString("default", { month: "long", year: "numeric" });
  };

  const sortedCards = [...cards].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  const monthGroups = {};
  const monthOrder = [];
  sortedCards.forEach(c => {
    const k = getMonthKey(c.date);
    if (!monthGroups[k]) { monthGroups[k] = []; monthOrder.push(k); }
    monthGroups[k].push(c);
  });

  const cellStyle = {
    background: "transparent", border: "none", outline: "none", width: "100%",
    color: T.textPrimary, fontSize: 11, fontFamily: T.fontMono,
    padding: "4px 6px", boxSizing: "border-box",
  };

  if (!loaded) return <div style={{ color: T.textFaint, fontFamily: T.fontVT, fontSize: 16, padding: 40, textAlign: "center" }}>loading listings...</div>;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6, flexWrap: "wrap", gap: 10 }}>
        <div><SectionTitle>Application Tracker</SectionTitle><SectionSub>Type directly in rows · ▼ to expand JD/notes · DOCS/PREP to route to AI tools</SectionSub></div>
      </div>

      {/* Toolbar */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <Btn onClick={() => setShowModal(true)} label="[ + FULL LISTING ]" small />
        <div style={{ position: "relative", display: "inline-block" }}>
          <select
            onChange={e => {
              const id = `month-section-${e.target.value}`;
              const el = document.getElementById(id);
              if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
              e.target.value = "";
            }}
            defaultValue=""
            style={{ background: T.bgInset, border: `1px solid ${T.border}`, borderRadius: 2, padding: "5px 28px 5px 10px", fontSize: 11, fontFamily: T.fontVT, letterSpacing: 0.8, cursor: "pointer", color: T.textMuted, boxShadow: T.shadow, appearance: "none", WebkitAppearance: "none" }}>
            <option value="" disabled>◈ JUMP TO</option>
            {monthOrder.map(m => <option key={m} value={m.replace(/\s/g, "-")}>{m.toUpperCase()}</option>)}
          </select>
          <span style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", color: T.textFaint, fontSize: 9, pointerEvents: "none" }}>▾</span>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <input ref={uploadRef} type="file" accept=".csv,.xlsx,.xls" onChange={uploadSpreadsheet} style={{ display: "none" }} />
          <button onClick={() => uploadRef.current.click()} style={{ background: T.bgInset, border: `1px solid ${T.border}`, borderRadius: 2, padding: "5px 12px", fontSize: 11, fontFamily: T.fontVT, letterSpacing: 0.8, cursor: "pointer", color: T.textSecondary, boxShadow: T.shadow }}>↑ UPLOAD (.csv)</button>
          <button onClick={() => {
            if (!cards.length) return;
            const headers = ["Company", "Role", "Status", "Date", "Compensation", "Location", "Job Type", "Link", "Job Description", "Notes"];
            const rows = cards.map(c => [c.company || "", c.role || "", c.status || "", c.date || "", c.compensation || "", c.location || "", c.jobType || "", c.link || "", (c.jd || "").replace(/"/g, '""'), (c.notes || "").replace(/"/g, '""')].map(v => `"${v}"`).join(","));
            const csv = [headers.join(","), ...rows].join("\n");
            const blob = new Blob([csv], { type: "text/csv" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a"); a.href = url; a.download = "job_applications.csv"; a.click(); URL.revokeObjectURL(url);
          }} style={{ background: T.bgInset, border: `1px solid ${T.border}`, borderRadius: 2, padding: "5px 12px", fontSize: 11, fontFamily: T.fontVT, letterSpacing: 0.8, cursor: cards.length ? "pointer" : "not-allowed", color: cards.length ? T.textSecondary : T.textFaint, boxShadow: cards.length ? T.shadow : "none" }}>↓ DOWNLOAD</button>
          <button onClick={() => {
            if (!cards.length) return;
            setCards([]);
            try { localStorage.setItem("tracker-cards", JSON.stringify([])); } catch {}
          }} style={{ background: T.redBg, color: T.red, border: `1px solid ${T.red}55`, borderRadius: 2, padding: "5px 12px", fontSize: 11, fontFamily: T.fontVT, letterSpacing: 0.8, cursor: cards.length ? "pointer" : "not-allowed", boxShadow: cards.length ? T.shadow : "none", opacity: cards.length ? 1 : 0.5 }}>[ CLEAR ALL ]</button>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        {[["Applied", applied, T.accentLight], ["In Progress", inProgress, T.amber], ["Total", cards.length, T.accent]].map(([l, v, c]) => (
          <Panel key={l} style={{ flex: "1 1 80px", minWidth: 80, padding: "8px 14px", background: T.bgInset }}>
            <div style={{ color: T.textMuted, fontSize: 9, fontFamily: T.fontVT, letterSpacing: 1, marginBottom: 2 }}>{l}</div>
            <div style={{ color: c, fontSize: 26, fontFamily: T.fontVT, lineHeight: 1 }}>{v}</div>
          </Panel>
        ))}
      </div>

      {/* Spreadsheet — resizable columns via CSS resize trick */}
      <div className="tracker-scroll" style={{ border: `1px solid ${T.border}`, borderRadius: 3, overflow: "hidden", boxShadow: T.shadow }}>
        {/* Header */}
        <div style={{ display: "grid", gridTemplateColumns: "18% 18% 9% 9% 10% 10% 7% 1fr", background: T.accentBg, borderBottom: `2px solid ${T.border}` }}>
          {["COMPANY", "ROLE", "COMP", "TYPE", "LOCATION", "STATUS", "DATE", ""].map((h, i) => (
            <div key={i} style={{ padding: "6px 8px", color: T.accent, fontSize: 9, fontFamily: T.fontVT, letterSpacing: 1.5, borderRight: i < 7 ? `1px solid ${T.border}` : "none", overflow: "hidden" }}>{h}</div>
          ))}
        </div>

        {/* Month groups */}
        {monthOrder.map(month => (
          <div key={month} id={`month-section-${month.replace(/\s/g, "-")}`} style={{ scrollMarginTop: 8 }}>
            <div style={{ background: T.bgPanel, borderBottom: `1px solid ${T.border}`, padding: "4px 10px", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: T.textMuted, fontSize: 10, fontFamily: T.fontVT, letterSpacing: 1 }}>◈ {month.toUpperCase()}</span>
              <span style={{ color: T.textFaint, fontSize: 9, fontFamily: T.fontVT }}>{monthGroups[month].length}</span>
            </div>
            {monthGroups[month].map((card, idx) => (
              <SpreadsheetRow key={card.id} card={card} idx={idx} expandedId={expandedId} setExpandedId={setExpandedId}
                updateCardField={updateCardField} openEdit={openEdit} delCard={delCard}
                setFileGenJob={setFileGenJob} setInterviewJob={setInterviewJob} setActiveTab={setActiveTab} />
            ))}
          </div>
        ))}

        {/* New row */}
        <div style={{ display: "grid", gridTemplateColumns: "18% 18% 9% 9% 10% 10% 7% 1fr", background: T.bgInset, borderTop: `1px dashed ${T.border}` }}>
          {[
            <input key="co" value={newRow.company} onChange={e => setNewRow(r => ({ ...r, company: e.target.value }))} onKeyDown={e => { if (e.key === "Enter") commitNewRow(); }} placeholder="+ Company..." style={{ ...cellStyle, color: T.textFaint }} />,
            <input key="ro" value={newRow.role} onChange={e => setNewRow(r => ({ ...r, role: e.target.value }))} onKeyDown={e => { if (e.key === "Enter") commitNewRow(); }} placeholder="Role..." style={{ ...cellStyle, color: T.textFaint }} />,
            <input key="cp" value={newRow.compensation} onChange={e => setNewRow(r => ({ ...r, compensation: e.target.value }))} placeholder="Comp..." style={{ ...cellStyle, color: T.textFaint }} />,
            <select key="jt" value={newRow.jobType} onChange={e => setNewRow(r => ({ ...r, jobType: e.target.value }))} style={{ ...cellStyle, background: "transparent", cursor: "pointer", color: T.textFaint }}>
              <option value="">Type</option><option>Remote</option><option>Hybrid</option><option>On-site</option>
            </select>,
            <input key="lo" value={newRow.location} onChange={e => setNewRow(r => ({ ...r, location: e.target.value }))} placeholder="Location..." style={{ ...cellStyle, color: T.textFaint }} />,
            <select key="st" value={newRow.status} onChange={e => setNewRow(r => ({ ...r, status: e.target.value }))} style={{ ...cellStyle, background: "transparent", cursor: "pointer", color: T.textFaint }}>
              {ALL_STATUSES.map(s => <option key={s}>{s}</option>)}
            </select>,
            <div key="dt" style={{ padding: "4px 6px", color: T.textFaint, fontSize: 10, fontFamily: T.fontMono }}>today</div>,
            <div key="act" style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 4px" }}>
              <input key="url" value={newRow.link || ""} onChange={e => setNewRow(r => ({ ...r, link: e.target.value }))} onKeyDown={e => { if (e.key === "Enter") commitNewRow(); }} placeholder="url..." style={{ ...cellStyle, color: T.accent, fontSize: 10, flex: 1, minWidth: 0 }} />
              <span onClick={commitNewRow} style={{ color: T.accentLight, fontSize: 11, fontFamily: T.fontVT, fontStyle: "italic", cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" }}>↵</span>
            </div>,
          ].map((el, i) => (
            <div key={i} style={{ borderRight: i < 7 ? `1px solid ${T.border}` : "none" }}>{el}</div>
          ))}
        </div>
      </div>

      {cards.length === 0 && (
        <div style={{ textAlign: "center", padding: "20px 0", color: T.textFaint, fontFamily: T.fontMono, fontSize: 11 }}>
          Type in the row above to add your first listing, or click [ + FULL LISTING ] for more fields.
        </div>
      )}

      {/* Add/Edit modal */}
      {showModal && (
        <div style={{ position: "fixed", inset: 0, background: "#1a2830cc", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div style={{ background: T.bgPanel, border: `2px solid ${T.border}`, borderRadius: 4, padding: 26, width: 480, maxWidth: "94vw", boxShadow: "4px 4px 0 " + T.border, maxHeight: "90vh", overflowY: "auto" }}>
            <h3 style={{ fontFamily: T.fontVT, fontSize: 20, color: T.textPrimary, margin: "0 0 18px", letterSpacing: 1 }}>{editingId ? "[ EDIT LISTING ]" : "[ ADD JOB LISTING ]"}</h3>
            <div style={{ marginBottom: 14 }}>
              <FieldLabel>Job Listing URL</FieldLabel>
              <input value={form.link} onChange={e => setForm(f => ({ ...f, link: e.target.value }))} placeholder="https://..."
                style={{ width: "100%", background: T.bgInset, border: `1px solid ${T.border}`, borderRadius: 2, padding: "8px 10px", color: T.textPrimary, fontSize: 12, fontFamily: T.fontMono, outline: "none", boxShadow: T.shadowInset, boxSizing: "border-box" }} />
            </div>
            <div style={{ marginBottom: 14 }}>
              <FieldLabel>Full Job Description</FieldLabel>
              <textarea value={form.jd} onChange={e => setForm(f => ({ ...f, jd: e.target.value }))} rows={4} placeholder="Paste the full job description..."
                style={{ width: "100%", background: T.bgInset, border: `1px solid ${T.border}`, borderRadius: 2, padding: "8px 10px", color: T.textPrimary, fontSize: 12, fontFamily: T.fontMono, outline: "none", boxShadow: T.shadowInset, resize: "vertical", boxSizing: "border-box", marginBottom: 8 }} />
              <Btn onClick={prefillFromUrl} loading={prefilling} label="✦ FILL" small variant="ghost" />
            </div>
            {/* Role/Title and Company with autocomplete */}
            <div className="grid-2" style={{ gap: 10 }}>
              <TextInput label="Role / Title *" value={form.role} onChange={v => setForm(f => ({ ...f, role: v }))} placeholder="Creative Director" />
              <div ref={companyRef} style={{ position: "relative", marginBottom: 14 }}>
                <FieldLabel>Company *</FieldLabel>
                <input value={form.company} onChange={e => setForm(f => ({ ...f, company: e.target.value }))}
                  onFocus={() => setCompanyFocused(true)}
                  placeholder="Company name"
                  style={{ width: "100%", background: T.bgInset, border: `1px solid ${T.border}`, borderRadius: 2, padding: "8px 10px", color: T.textPrimary, fontSize: 12, fontFamily: T.fontMono, outline: "none", boxSizing: "border-box", boxShadow: T.shadowInset }} />
                {companyFocused && companyMatches.length > 0 && (
                  <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 60, background: T.bgPanel, border: `1px solid ${T.accent}`, borderRadius: "0 0 2px 2px", boxShadow: "2px 4px 8px rgba(0,0,0,0.12)" }}>
                    {companyMatches.map((co, i) => (
                      <div key={i} onMouseDown={() => { setForm(f => ({ ...f, company: co })); setCompanyFocused(false); }}
                        style={{ padding: "7px 12px", fontSize: 12, fontFamily: T.fontMono, color: T.textPrimary, cursor: "pointer", borderBottom: i < companyMatches.length - 1 ? `1px solid ${T.borderLight}` : "none" }}
                        onMouseEnter={e => e.currentTarget.style.background = T.accentBg}
                        onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                        {co}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <TextInput label="Compensation" value={form.compensation} onChange={v => setForm(f => ({ ...f, compensation: v }))} placeholder="$80k–$100k / $45/hr" />
            <div className="grid-2" style={{ gap: 10 }}>
              <TextInput label="Location" value={form.location} onChange={v => setForm(f => ({ ...f, location: v }))} placeholder="Austin, TX / Remote" />
              <div style={{ marginBottom: 14 }}>
                <FieldLabel>Job Type</FieldLabel>
                <select value={form.jobType} onChange={e => setForm(f => ({ ...f, jobType: e.target.value }))} style={{ width: "100%", background: T.bgInset, border: `1px solid ${T.border}`, borderRadius: 2, padding: "7px 10px", fontSize: 12, fontFamily: T.fontMono, color: form.jobType ? T.textPrimary : T.textFaint, boxShadow: T.shadowInset }}>
                  <option value="">— select —</option><option>Remote</option><option>Hybrid</option><option>On-site</option>
                </select>
              </div>
            </div>
            <TextArea label="Notes" value={form.notes} onChange={v => setForm(f => ({ ...f, notes: v }))} rows={2} placeholder="Personal notes, contacts, follow-ups..." />
            <div style={{ marginBottom: 16 }}>
              <FieldLabel>Status</FieldLabel>
              <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))} style={{ background: T.bgInset, border: `1px solid ${T.border}`, borderRadius: 2, padding: "7px 10px", fontSize: 12, fontFamily: T.fontMono, color: T.textPrimary, width: "100%", boxShadow: T.shadowInset }}>
                {ALL_STATUSES.map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <Btn onClick={addCard} label={editingId ? "[ SAVE CHANGES ]" : "[ SAVE LISTING ]"} />
              <Btn onClick={() => { setShowModal(false); setEditingId(null); setForm({ company: "", role: "", link: "", compensation: "", location: "", jobType: "", jd: "", notes: "", status: "Saved" }); }} label="CANCEL" variant="ghost" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

function SpreadsheetRow({ card, idx, expandedId, setExpandedId, updateCardField, openEdit, delCard, setFileGenJob, setInterviewJob, setActiveTab }) {
  const isExpanded = expandedId === card.id;
  const rowBg = idx % 2 === 0 ? T.bgPanel : T.bgInset;
  const cellStyle = { background: "transparent", border: "none", outline: "none", width: "100%", color: T.textPrimary, fontSize: 11, fontFamily: T.fontMono, padding: "5px 6px", boxSizing: "border-box" };
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "18% 18% 9% 9% 10% 10% 7% 1fr", background: rowBg, borderBottom: `1px solid ${T.borderLight}`, minHeight: 34 }}>
        <div style={{ borderRight: `1px solid ${T.borderLight}` }}>
          <input value={card.company || ""} onChange={e => updateCardField(card.id, "company", e.target.value)} style={cellStyle} />
        </div>
        <div style={{ borderRight: `1px solid ${T.borderLight}` }}>
          <input value={card.role || ""} onChange={e => updateCardField(card.id, "role", e.target.value)} style={{ ...cellStyle, fontWeight: 600 }} />
        </div>
        <div style={{ borderRight: `1px solid ${T.borderLight}` }}>
          <input value={card.compensation || ""} onChange={e => updateCardField(card.id, "compensation", e.target.value)} style={{ ...cellStyle, color: T.green }} placeholder="—" />
        </div>
        <div style={{ borderRight: `1px solid ${T.borderLight}` }}>
          <select value={card.jobType || ""} onChange={e => updateCardField(card.id, "jobType", e.target.value)}
            style={{ ...cellStyle, cursor: "pointer", fontSize: 10, color: card.jobType ? T.accentLight : T.textFaint }}>
            <option value="">—</option><option>Remote</option><option>Hybrid</option><option>On-site</option>
          </select>
        </div>
        <div style={{ borderRight: `1px solid ${T.borderLight}` }}>
          <input value={card.location || ""} onChange={e => updateCardField(card.id, "location", e.target.value)} style={cellStyle} placeholder="—" />
        </div>
        <div style={{ borderRight: `1px solid ${T.borderLight}` }}>
          <select value={card.status} onChange={e => updateCardField(card.id, "status", e.target.value)}
            style={{ ...cellStyle, background: STATUS_BG[card.status], color: STATUS_COLOR[card.status], cursor: "pointer", fontSize: 10 }}>
            {ALL_STATUSES.map(s => <option key={s} style={{ background: T.bgPanel, color: T.textPrimary }}>{s}</option>)}
          </select>
        </div>
        <div style={{ borderRight: `1px solid ${T.borderLight}`, padding: "5px 6px", color: T.textFaint, fontSize: 10, fontFamily: T.fontMono }}>
          {card.date ? new Date(card.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : "—"}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "3px 4px", justifyContent: "center", height: "100%" }}>
          <div style={{ display: "flex", gap: 2 }}>
            {card.link
              ? <a href={card.link.startsWith("http") ? card.link : "https://" + card.link} target="_blank" rel="noreferrer"
                  style={{ background: "transparent", border: `1px solid ${T.border}`, color: T.accent, borderRadius: 2, padding: "2px 5px", fontSize: 9, cursor: "pointer", fontFamily: T.fontVT, flexShrink: 0, textDecoration: "none" }}>↗</a>
              : <span style={{ padding: "2px 5px", fontSize: 9, width: 18 }} />
            }
            <button onClick={() => { setFileGenJob({ company: card.company, role: card.role, jd: card.jd || "", notes: card.notes || "" }); setActiveTab("filegen"); }}
              style={{ background: "#ddeef8", border: `1px solid ${T.accentLight}55`, color: T.accentLight, borderRadius: 2, padding: "2px 5px", fontSize: 9, cursor: "pointer", fontFamily: T.fontVT, flexShrink: 0 }}>DOCS</button>
            <button onClick={() => { setInterviewJob({ company: card.company, title: card.role, jd: card.jd || "", notes: card.notes || "", stage: card.status }); setActiveTab("interview"); }}
              style={{ background: T.accentBg, border: `1px solid ${T.accent}55`, color: T.accent, borderRadius: 2, padding: "2px 5px", fontSize: 9, cursor: "pointer", fontFamily: T.fontVT, flexShrink: 0 }}>PREP</button>
          </div>
          <div style={{ display: "flex", gap: 2 }}>
            <button onClick={() => setExpandedId(isExpanded ? null : card.id)}
              style={{ background: T.bgInset, border: `1px solid ${T.border}`, color: T.textMuted, borderRadius: 2, padding: "2px 5px", fontSize: 9, cursor: "pointer", fontFamily: T.fontVT, flexShrink: 0 }}>{isExpanded ? "▲" : "▼"}</button>
            <button onClick={() => openEdit(card)}
              style={{ background: T.bgInset, border: `1px solid ${T.border}`, color: T.textMuted, borderRadius: 2, padding: "2px 5px", fontSize: 9, cursor: "pointer", fontFamily: T.fontVT, flexShrink: 0 }}>✎</button>
            <button onClick={() => delCard(card.id)}
              style={{ background: T.accentBg, border: `1px solid ${T.accent}44`, color: T.accent, borderRadius: 2, padding: "2px 5px", fontSize: 11, cursor: "pointer", fontFamily: T.fontVT, flexShrink: 0 }}>✕</button>
          </div>
        </div>
      </div>
      {isExpanded && (
        <div style={{ background: T.bgInset, borderBottom: `1px solid ${T.border}`, padding: "10px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <div style={{ color: T.textMuted, fontSize: 10, fontFamily: T.fontVT, letterSpacing: 1, marginBottom: 4 }}>JOB DESCRIPTION</div>
            <textarea value={card.jd || ""} onChange={e => updateCardField(card.id, "jd", e.target.value)} rows={4} placeholder="Paste job description..."
              style={{ width: "100%", background: T.bgPanel, border: `1px solid ${T.border}`, borderRadius: 2, padding: "8px 10px", color: T.textPrimary, fontSize: 11, fontFamily: T.fontMono, resize: "vertical", outline: "none", boxSizing: "border-box", lineHeight: 1.6 }} />
          </div>
          <div>
            <div style={{ color: T.textMuted, fontSize: 10, fontFamily: T.fontVT, letterSpacing: 1, marginBottom: 4 }}>NOTES</div>
            <textarea value={card.notes || ""} onChange={e => updateCardField(card.id, "notes", e.target.value)} rows={2} placeholder="Personal notes..."
              style={{ width: "100%", background: T.bgPanel, border: `1px solid ${T.border}`, borderRadius: 2, padding: "8px 10px", color: T.textPrimary, fontSize: 11, fontFamily: T.fontMono, resize: "vertical", outline: "none", boxSizing: "border-box", lineHeight: 1.6 }} />
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ color: T.textMuted, fontSize: 10, fontFamily: T.fontVT, letterSpacing: 1, flexShrink: 0 }}>LINK</div>
            <input value={card.link || ""} onChange={e => updateCardField(card.id, "link", e.target.value)} placeholder="https://..."
              style={{ flex: 1, background: T.bgPanel, border: `1px solid ${T.border}`, borderRadius: 2, padding: "5px 8px", color: T.accent, fontSize: 11, fontFamily: T.fontMono, outline: "none" }} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── FILE GENERATOR ────────────────────────────────────────────────────────────
const FileGenTab = memo(function FileGenTab({ profile, prefillJob }) {
  const [subTab, setSubTab] = useState("cover");
  const [company, setCompany] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [jd, setJd] = useState("");
  const [tone, setTone] = useState("Professional");
  const [coverOut, setCoverOut] = useState("");
  const [coverLoading, setCoverLoading] = useState(false);
  const [coverNotes, setCoverNotes] = useState("");
  const [resumeNotes, setResumeNotes] = useState("");
  const [resumeJobTitle, setResumeJobTitle] = useState("");
  const [resumeCompany, setResumeCompany] = useState("");
  const [resumeJd, setResumeJd] = useState("");
  const [resumeOut, setResumeOut] = useState("");
  const [resumeLoading, setResumeLoading] = useState(false);
  const [autoNote, setAutoNote] = useState("");
  const [fgLoaded, setFgLoaded] = useState(false);
  const [coverAbort, setCoverAbort] = useState(null);
  const [resumeAbort, setResumeAbort] = useState(null);
  const TONES = ["Professional", "Enthusiastic", "Concise", "Creative"];
  const prevJobRef = useRef(null);
  const hasPrefilled = useRef(false);

  // Handle prefill FIRST - before storage load
  useEffect(() => {
    if (prefillJob && prefillJob !== prevJobRef.current) {
      prevJobRef.current = prefillJob;
      hasPrefilled.current = true;
      setCompany(prefillJob.company || "");
      setJobTitle(prefillJob.role || "");
      setJd(prefillJob.jd || "");
      setCoverNotes(prefillJob.notes || "");
      setResumeJobTitle(prefillJob.role || "");
      setResumeCompany(prefillJob.company || "");
      setResumeNotes(prefillJob.notes || "");
      setResumeJd(prefillJob.jd || "");
      setAutoNote(`Auto-populated from tracker: ${prefillJob.company} — ${prefillJob.role}`);
      setCoverOut(""); setResumeOut("");
      setFgLoaded(true);
    }
  }, [prefillJob]);

  // Load from storage only if no prefill
  useEffect(() => {
    if (hasPrefilled.current) return;
    (async () => {
      try {
        const r = localStorage.getItem("filegen-state");
        if (r) {
          const d = JSON.parse(r);
          if (d.company) setCompany(d.company);
          if (d.jobTitle) setJobTitle(d.jobTitle);
          if (d.jd) setJd(d.jd);
          if (d.tone) setTone(d.tone);
          if (d.coverOut) setCoverOut(d.coverOut);
          if (d.coverNotes) setCoverNotes(d.coverNotes);
          if (d.resumeJobTitle) setResumeJobTitle(d.resumeJobTitle);
          if (d.resumeCompany) setResumeCompany(d.resumeCompany);
          if (d.resumeNotes) setResumeNotes(d.resumeNotes);
          if (d.resumeJd) setResumeJd(d.resumeJd);
          if (d.resumeOut) setResumeOut(d.resumeOut);
        }
      } catch {}
      setFgLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!fgLoaded || coverLoading || resumeLoading) return; // Don't save during streaming
    const t = setTimeout(async () => {
      try { localStorage.setItem("filegen-state", JSON.stringify({ company, jobTitle, jd, tone, coverNotes, coverOut, resumeJobTitle, resumeCompany, resumeNotes, resumeJd, resumeOut })); } catch {}
    }, 400);
    return () => clearTimeout(t);
  }, [company, jobTitle, jd, tone, coverNotes, coverOut, resumeJobTitle, resumeCompany, resumeNotes, resumeJd, resumeOut, fgLoaded, coverLoading, resumeLoading]);

  const genCover = async () => {
    const hasProfile = profile.summary || (profile.experience || []).some(e => e.role || e.company);
    if (!hasProfile) { alert("Fill in your Job Seeker Profile first!"); return; }
    setCoverLoading(true); setCoverOut("");
    const ctrl = new AbortController();
    setCoverAbort(() => () => { ctrl.abort(); setCoverLoading(false); });
    try {
      const ctx = buildContext(profile);
      const hasTemplate = profile.coverTemplate && profile.coverTemplate.trim().length > 0;
      const sys = `You are an expert cover letter writer for Creative, Marketing, and Business/Operations roles. Here is the candidate's COMPLETE background — reference their actual job titles, companies, and skills by name:\n\n${ctx}`;
      const prompt = hasTemplate
        ? `Tailor this cover letter template for the job below. Keep the writer's voice — only change what's needed to make it specific to this role. Mark every changed or added line with [UPDATED].\n\nCover letter template:\n${profile.coverTemplate.slice(0, 800)}\n\nTarget job:\nCompany: ${company}\nRole: ${jobTitle}\nJD: ${jd.slice(0, 1200)}\nTone: ${tone}${coverNotes ? "\nAdditional notes: " + coverNotes.slice(0, 400) : ""}`
        : `Write a ${tone} cover letter for:\nCompany: ${company}\nRole: ${jobTitle}\nJD: ${jd.slice(0, 1200)}${coverNotes ? "\nAdditional notes: " + coverNotes.slice(0, 400) : ""}\n\nDraw directly from the candidate's actual experience above.${profile.linkedin ? " Include LinkedIn: " + profile.linkedin : ""}${profile.portfolio ? " Portfolio: " + profile.portfolio : ""}`;
      const result = await callClaude(sys, prompt, 3000, chunk => setCoverOut(chunk), ctrl.signal);
      setCoverOut(result);
    } catch (e) { 
      console.error("Cover letter error:", e);
      if (e.name !== "AbortError") setCoverOut("Error: " + (e.message || "Unknown error — please retry.")); 
    }
    setCoverLoading(false);
  };

  const genResume = async () => {
    const hasProfile = profile.summary || (profile.experience || []).some(e => e.role || e.company);
    if (!hasProfile) { alert("Fill in your Job Seeker Profile first!"); return; }
    setResumeLoading(true); setResumeOut("");
    const ctrl = new AbortController();
    setResumeAbort(() => () => { ctrl.abort(); setResumeLoading(false); });
    try {
      const ctx = buildContext(profile);
      const result = await callClaude(
        `You are an ATS optimization expert for Creative, Marketing, and Business/Operations professionals. CRITICAL: Keep the optimized resume the SAME LENGTH as the original — do not add extra lines, spacing, or content. The candidate has tight formatting constraints.`,
        `Here is the candidate's full profile:\n${ctx}\n\nTarget role: ${resumeJobTitle || "not specified"}\nTarget company: ${resumeCompany || "not specified"}\nJob description:\n${resumeJd.slice(0, 1200)}${resumeNotes ? "\nAdditional notes: " + resumeNotes.slice(0, 400) : ""}\n\nRewrite and optimize this candidate's resume to match the JD. IMPORTANT: Maintain the same character count and line count as the original — swap keywords and rephrase, but do NOT expand or add new sections. Weave in relevant keywords naturally, lead with most relevant experience, quantify where possible, mark changed/added lines with [UPDATED]. Return the full optimized resume in clean text format.`,
        4000,
        chunk => setResumeOut(chunk),
        ctrl.signal
      );
      setResumeOut(result);
    } catch (e) { if (e.name !== "AbortError") setResumeOut("Error — please retry."); }
    setResumeLoading(false);
  };

  return (
    <div>
      <div style={{ marginBottom: 4 }}>
        <SectionTitle>File Generator</SectionTitle>
      </div>
      <SectionSub>Generate tailored cover letters and ATS-optimized resumes. Enter details manually, or use the tracker — DOCS button also auto-populates this tab.</SectionSub>

      {autoNote && (
        <Panel style={{ background: "transparent", border: `1px solid ${T.border}`, marginBottom: 16 }}>
          <span style={{ color: T.accent, fontSize: 11, fontFamily: T.fontVT, letterSpacing: 0.5 }}>◈ {autoNote}</span>
        </Panel>
      )}

      <div style={{ display: "flex", gap: 0, marginBottom: 22, border: `1px solid ${T.border}`, borderRadius: 2, overflow: "hidden", width: "fit-content", boxShadow: T.shadow }}>
        {[["cover", "Custom Cover Letter"], ["resume", "Resume Optimizer"]].map(([id, lbl]) => (
          <button key={id} onClick={() => setSubTab(id)} style={{ padding: "8px 20px", border: "none", cursor: "pointer", fontFamily: T.fontVT, fontSize: 13, letterSpacing: 0.8, background: subTab === id ? T.accent : T.bgInset, color: subTab === id ? "#fff" : T.textMuted, borderRight: id === "cover" ? `1px solid ${T.border}` : "none" }}>
            {lbl.toUpperCase()}
          </button>
        ))}
      </div>

      {subTab === "cover" ? (
        <div>
          <div style={{ marginBottom: 14 }}>
            <FieldLabel>Tone</FieldLabel>
            <div style={{ display: "flex", gap: 6 }}>{TONES.map(t => <Chip key={t} label={t} active={tone === t} onClick={() => setTone(t)} />)}</div>
          </div>
          <div className="grid-2" style={{ gap: 14 }}>
            <TextInput label="Job Title" value={jobTitle} onChange={setJobTitle} placeholder="Brand Strategist" />
            <TextInput label="Company Name" value={company} onChange={setCompany} placeholder="Acme Creative Co." />
          </div>
          <TextArea label="Job Description" value={jd} onChange={setJd} rows={5} placeholder="Paste the job description..." />
          <TextArea label="Notes" value={coverNotes} onChange={setCoverNotes} rows={2} placeholder="Additional context — brand tone, company details, anything from their website or the listing..." />
          <Panel style={{ background: T.amberBg, border: `1px solid ${T.amber}55`, marginBottom: 14 }}>
            <span style={{ color: T.amber, fontSize: 11, fontFamily: T.fontVT }}>
              {profile.coverTemplate
                ? "◈ Your cover letter template from Profile will be used as the basis — tailored to the role. Changed lines marked [UPDATED]."
                : "◈ No cover letter template in Profile — will be written from scratch. Add one in Profile for best results."}
            </span>
          </Panel>
          <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
            <Btn onClick={genCover} loading={coverLoading} label="[ GENERATE COVER LETTER ✦ ]" />
            <button onClick={() => {
              setCompany(""); setJobTitle(""); setJd(""); setTone("Professional"); setCoverNotes(""); setCoverOut("");
              setResumeJobTitle(""); setResumeCompany(""); setResumeJd(""); setResumeNotes(""); setResumeOut("");
              setAutoNote("");
              try { localStorage.setItem("filegen-state", JSON.stringify({ company: "", jobTitle: "", jd: "", tone: "Professional", coverNotes: "", coverOut: "", resumeJobTitle: "", resumeCompany: "", resumeNotes: "", resumeJd: "", resumeOut: "" })); } catch {}
            }} style={{ background: T.redBg, color: T.red, border: `1px solid ${T.red}55`, borderRadius: 2, padding: "5px 12px", fontSize: 11, fontFamily: T.fontVT, letterSpacing: 0.8, cursor: "pointer", boxShadow: T.shadow, whiteSpace: "nowrap" }}>[ CLEAR ALL ]</button>
          </div>
          <div style={{ marginTop: 18 }}><AIOutput content={coverOut} loading={coverLoading} onClear={() => setCoverOut("")} onCancel={coverAbort} /></div>
        </div>
      ) : (
        <div>
          <div className="grid-2" style={{ gap: 14 }}>
            <TextInput label="Job Title" value={resumeJobTitle} onChange={setResumeJobTitle} placeholder="Brand Strategist" />
            <TextInput label="Company Name" value={resumeCompany} onChange={setResumeCompany} placeholder="Acme Creative Co." />
          </div>
          <TextArea label="Job Description" value={resumeJd} onChange={setResumeJd} rows={6} placeholder="Paste the job description..." />
          <TextArea label="Notes" value={resumeNotes} onChange={setResumeNotes} rows={2} placeholder="Additional context..." />
          <Panel style={{ background: T.amberBg, border: `1px solid ${T.amber}55`, marginBottom: 14 }}>
            <span style={{ color: T.amber, fontSize: 11, fontFamily: T.fontVT }}>◈ Your resume from Profile will be optimized. Changed lines are marked [UPDATED].</span>
          </Panel>
          <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
            <Btn onClick={genResume} loading={resumeLoading} label="[ OPTIMIZE RESUME ✦ ]" />
            <button onClick={() => {
              setCompany(""); setJobTitle(""); setJd(""); setTone("Professional"); setCoverNotes(""); setCoverOut("");
              setResumeJobTitle(""); setResumeCompany(""); setResumeJd(""); setResumeNotes(""); setResumeOut("");
              setAutoNote("");
              try { localStorage.setItem("filegen-state", JSON.stringify({ company: "", jobTitle: "", jd: "", tone: "Professional", coverNotes: "", coverOut: "", resumeJobTitle: "", resumeCompany: "", resumeNotes: "", resumeJd: "", resumeOut: "" })); } catch {}
            }} style={{ background: T.redBg, color: T.red, border: `1px solid ${T.red}55`, borderRadius: 2, padding: "5px 12px", fontSize: 11, fontFamily: T.fontVT, letterSpacing: 0.8, cursor: "pointer", boxShadow: T.shadow, whiteSpace: "nowrap" }}>[ CLEAR ALL ]</button>
          </div>
          <div style={{ marginTop: 18 }}><AIOutput content={resumeOut} loading={resumeLoading} onClear={() => setResumeOut("")} onCancel={resumeAbort} /></div>
        </div>
      )}
    </div>
  );
});

// ── INTERVIEW PREP ────────────────────────────────────────────────────────────
const InterviewTab = memo(function InterviewTab({ profile, prefillJob }) {
  const [company, setCompany] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [jd, setJd] = useState("");
  const [notes, setNotes] = useState("");
  const [output, setOutput] = useState("");
  const [loading, setLoading] = useState(false);
  const [briefOutput, setBriefOutput] = useState("");
  const [briefLoading, setBriefLoading] = useState(false);
  const [autoNote, setAutoNote] = useState("");
  const [ipLoaded, setIpLoaded] = useState(false);
  const [prepAbort, setPrepAbort] = useState(null);
  const [briefAbort, setBriefAbort] = useState(null);
  const prevJobRef = useRef(null);
  const hasPrefilled = useRef(false);

  // Handle prefill FIRST - before storage load
  useEffect(() => {
    if (prefillJob && prefillJob !== prevJobRef.current) {
      prevJobRef.current = prefillJob;
      hasPrefilled.current = true;
      setCompany(prefillJob.company || "");
      setJobTitle(prefillJob.title || "");
      setJd(prefillJob.jd || "");
      setNotes(prefillJob.notes || "");
      setOutput("");
      setBriefOutput("");
      setAutoNote(`Auto-populated from tracker: ${prefillJob.company} — ${prefillJob.title}`);
      setIpLoaded(true); // Mark as loaded so we don't overwrite
    }
  }, [prefillJob]);

  // Load from storage only if no prefill
  useEffect(() => {
    if (hasPrefilled.current) return; // Skip if we already prefilled
    (async () => {
      try {
        const r = localStorage.getItem("interview-state");
        if (r) {
          const d = JSON.parse(r);
          if (d.company) setCompany(d.company);
          if (d.jobTitle) setJobTitle(d.jobTitle);
          if (d.jd) setJd(d.jd);
          if (d.notes) setNotes(d.notes);
          if (d.output) setOutput(d.output);
          if (d.briefOutput) setBriefOutput(d.briefOutput);
        }
      } catch {}
      setIpLoaded(true);
    })();
  }, []);

  // Save to storage (skip during streaming)
  useEffect(() => {
    if (!ipLoaded || loading || briefLoading) return;
    const t = setTimeout(async () => {
      try { localStorage.setItem("interview-state", JSON.stringify({ company, jobTitle, jd, notes, output, briefOutput })); } catch {}
    }, 400);
    return () => clearTimeout(t);
  }, [company, jobTitle, jd, notes, output, briefOutput, ipLoaded, loading, briefLoading]);

  const generate = async () => {
    const hasProfile = profile.summary || (profile.experience || []).some(e => e.role || e.company);
    if (!hasProfile) { alert("Fill in your Job Seeker Profile first!"); return; }
    setLoading(true); setOutput("");
    const ctrl = new AbortController();
    setPrepAbort(() => () => { ctrl.abort(); setLoading(false); });
    try {
      const ctx = buildContext(profile);
      const sys = `You are an elite interview coach who prepares candidates with hyper-specific, deeply personalized prep guides. You have the candidate's COMPLETE background — reference their actual job titles, companies, skills, and achievements by name throughout. Never use placeholders.\n\nCANDIDATE BACKGROUND:\n${ctx}`;
      const prompt = `Prepare interview prep for ${company} - ${jobTitle}.
JD: ${jd.slice(0, 1500)}${notes ? "\nNotes: " + notes.slice(0, 600) : ""}

Structure output as:
1. BRAND & COMPANY CONTEXT - mission, audience, 2-3 discussion topics
2. ROLE OVERVIEW - 4-5 core capabilities from JD, map to candidate background
3. INTERVIEW Q&A - Group into 4-5 themes. Per section: expected questions, talking points using real experience, 1-2 STAR answers
4. KEY METRICS & LANGUAGE - 6-8 terms/tools/frameworks with usage examples
5. EXPERIENCE TO HIGHLIGHT - Tools/skills to mention, bridge gaps
6. LIVE EXERCISE PREP - Likely case prompt + response framework
7. SMART QUESTIONS - 5 tailored questions
8. SALARY NEGOTIATION - Range, 2-3 phrases, leverage points
9. FINAL CHECKLIST - 6-8 items

Use candidate's actual experience. Be specific.`;
      const result = await callClaude(sys, prompt, 8000, chunk => setOutput(chunk), ctrl.signal);
      setOutput(result);
    } catch (e) { 
      console.error("Interview prep error:", e);
      if (e.name !== "AbortError") setOutput("Error: " + (e.message || "Unknown error — please retry.")); 
    }
    setLoading(false);
  };

  const generateBrief = async () => {
    const hasProfile = profile.summary || (profile.experience || []).some(e => e.role || e.company);
    if (!hasProfile) { alert("Fill in your Job Seeker Profile first!"); return; }
    setBriefLoading(true); setBriefOutput("");
    const ctrl = new AbortController();
    setBriefAbort(() => () => { ctrl.abort(); setBriefLoading(false); });
    try {
      const ctx = buildContext(profile);
      const sys = `You are an expert interview coach. Create a tight, scannable one-page interview cheat sheet. Use the candidate's real background.\n\nCANDIDATE BACKGROUND:\n${ctx}`;
      const prompt = `One-page cheat sheet for ${company || "unknown"} - ${jobTitle || "unknown"}.
JD: ${jd.slice(0, 1200)}${notes ? "\nContext: " + notes.slice(0, 400) : ""}

Format:
QUICK BRIEF — ${(company || "Company").toUpperCase()} · ${(jobTitle || "Role").toUpperCase()}

◈ COMPANY SNAPSHOT - mission (1 line), brand tone (1 line), 1-2 things to reference
◈ WHAT THEY'RE LOOKING FOR - 3-4 bullets from JD
◈ YOUR TOP 5 TALKING POINTS - Numbered. Each: specific achievement/skill mapping to role with company, metric, impact
◈ CURVEBALL QUESTIONS - 3 tricky questions + 1-line strategy each
◈ SMART QUESTIONS - 4 sharp questions specific to company/role
◈ NEGOTIATION NOTE - Comp range, strongest leverage point (1 sentence)
◈ BEFORE YOU WALK IN - 5-item checklist

Keep punchy.`;
      const result = await callClaude(sys, prompt, 2500, chunk => setBriefOutput(chunk), ctrl.signal);
      setBriefOutput(result);
    } catch (e) { if (e.name !== "AbortError") setBriefOutput("Error — please retry."); }
    setBriefLoading(false);
  };

  return (
    <div>
      <div style={{ marginBottom: 4 }}>
        <SectionTitle>Interview Prep</SectionTitle>
      </div>
      <SectionSub>Full personalized prep guide — brand context, Q&A with STAR answers from your real background, metrics, tools, live exercise prep, and salary negotiation.</SectionSub>

      {autoNote && (
        <Panel style={{ background: "transparent", border: `1px solid ${T.border}`, marginBottom: 16 }}>
          <span style={{ color: T.accent, fontSize: 11, fontFamily: T.fontVT, letterSpacing: 0.5 }}>◈ {autoNote}</span>
        </Panel>
      )}

      <div className="grid-2" style={{ gap: 14 }}>
        <TextInput label="Job Title" value={jobTitle} onChange={setJobTitle} placeholder="Marketing Manager, Art Director..." />
        <TextInput label="Company" value={company} onChange={setCompany} placeholder="Company name" />
      </div>
      <TextArea label="Job Description" value={jd} onChange={setJd} rows={6} placeholder="Paste the full job description — the more detail, the better the prep..." />
      <TextArea label="Notes" value={notes} onChange={setNotes} rows={2} placeholder="Additional context — brand tone, recent campaigns, company stage, anything from their website or socials..." />
      <div style={{ marginBottom: 18, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Btn onClick={generate} loading={loading} label="[ GENERATE FULL PREP GUIDE ✦ ]" />
          <button onClick={generateBrief} disabled={briefLoading} style={{ background: T.accentBg, color: T.accentLight, border: `1px solid ${T.accentLight}55`, borderRadius: 2, padding: "9px 18px", fontSize: 12, fontFamily: T.fontVT, letterSpacing: 0.8, cursor: briefLoading ? "not-allowed" : "pointer", boxShadow: briefLoading ? "none" : T.shadow, transition: "all .1s", whiteSpace: "nowrap" }}>{ briefLoading ? "[ PROCESSING... ]" : "[ ONE-PAGE QUICK BRIEF ✦ ]" }</button>
        </div>
        <button onClick={() => {
          setCompany(""); setJobTitle(""); setJd(""); setNotes(""); setOutput(""); setBriefOutput(""); setAutoNote("");
          try { localStorage.setItem("interview-state", JSON.stringify({ company: "", jobTitle: "", jd: "", notes: "", output: "", briefOutput: "" })); } catch {}
        }} style={{ background: T.redBg, color: T.red, border: `1px solid ${T.red}55`, borderRadius: 2, padding: "5px 12px", fontSize: 11, fontFamily: T.fontVT, letterSpacing: 0.8, cursor: "pointer", boxShadow: T.shadow, whiteSpace: "nowrap" }}>[ CLEAR ALL ]</button>
      </div>
      {(briefOutput || briefLoading) && (
        <div style={{ marginBottom: 22 }}>
          <div style={{ color: T.textMuted, fontSize: 10, fontFamily: T.fontVT, letterSpacing: 1.5, marginBottom: 6 }}>◈ QUICK BRIEF — ONE-PAGE CHEAT SHEET</div>
          <AIOutput content={briefOutput} loading={briefLoading} onClear={() => setBriefOutput("")} onCancel={briefAbort} />
        </div>
      )}
      <AIOutput content={output} loading={loading} onClear={() => setOutput("")} onCancel={prepAbort} />
    </div>
  );
});

const CareerDevTab = memo(function CareerDevTab({ profile, setProfile }) {
  const [goalsOutput, setGoalsOutput] = useState("");
  const [goalsLoading, setGoalsLoading] = useState(false);
  const [exploreOutput, setExploreOutput] = useState("");
  const [exploreLoading, setExploreLoading] = useState(false);
  const [pivotOutput, setPivotOutput] = useState("");
  const [pivotLoading, setPivotLoading] = useState(false);
  const [goals, setGoals] = useState("");
  const [workStyle, setWorkStyle] = useState("");
  const [cdLoaded, setCdLoaded] = useState(false);
  const [guidanceAbort, setGuidanceAbort] = useState(null);
  const [exploreAbort, setExploreAbort] = useState(null);
  const [pivotAbort, setPivotAbort] = useState(null);
  // Draggable output order: array of keys
  const [outputOrder, setOutputOrder] = useState(["goals", "explore", "pivot"]);
  const dragOutputRef = useRef(null);
  const dragOutputOverRef = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const r = localStorage.getItem("career-dev-state");
        if (r) {
          const d = JSON.parse(r);
          if (d.goals) setGoals(d.goals);
          if (d.workStyle) setWorkStyle(d.workStyle);
          if (d.goalsOutput) setGoalsOutput(d.goalsOutput);
          if (d.exploreOutput) setExploreOutput(d.exploreOutput);
          if (d.pivotOutput) setPivotOutput(d.pivotOutput);
        }
      } catch {}
      setCdLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!cdLoaded || goalsLoading || exploreLoading || pivotLoading) return; // Don't save during streaming
    const t = setTimeout(async () => {
      try { localStorage.setItem("career-dev-state", JSON.stringify({ goals, workStyle, goalsOutput, exploreOutput, pivotOutput })); } catch {}
    }, 400);
    return () => clearTimeout(t);
  }, [goals, workStyle, goalsOutput, exploreOutput, pivotOutput, cdLoaded, goalsLoading, exploreLoading, pivotLoading]);

  const ctx = buildContext(profile);
  const hasProfile = profile.summary || (profile.experience || []).some(e => e.role || e.company);
  const coNames = (profile.preferredCompanies || []).map(c => typeof c === "string" ? c : c.name).join(", ");

  const runGuidance = async () => {
    if (!hasProfile) { alert("Please fill in your profile first."); return; }
    setGoalsLoading(true); setGoalsOutput("");
    const ctrl = new AbortController();
    setGuidanceAbort(() => () => { ctrl.abort(); setGoalsLoading(false); });
    try {
      const sys = `You are a candid, highly personalized career coach for Creative, Marketing, and Business/Operations professionals. Here is the candidate's full background:\n\n${ctx}\n\nGoals: ${goals || "not specified"}\nWork style: ${workStyle || "not specified"}\nPreferred companies: ${coNames || "none"}`;
      const result = await callClaude(sys, `Give me a candid, personalized career assessment and action plan based on EVERYTHING in my profile. Include:

1. HONEST STRENGTHS — what genuinely stands out for my target roles.
2. GAPS TO ADDRESS — specific skills or credentials I'm missing for my target roles.
3. QUICK WINS — 3 things I can do THIS WEEK. Make them specific.
4. LONGER-TERM MOVES — 2–3 strategic steps over the next 6–12 months.
5. PERSONAL BRAND TIP — one specific thing I should emphasize or reframe.

Be direct. Reference my actual job titles, companies, and skills by name.`, 3500, chunk => setGoalsOutput(chunk), ctrl.signal);
      setGoalsOutput(result);
    } catch (e) { if (e.name !== "AbortError") setGoalsOutput("Error — please retry."); }
    setGoalsLoading(false);
  };

  const runExplore = async () => {
    if (!hasProfile) { alert("Please fill in your profile first."); return; }
    setExploreLoading(true); setExploreOutput("");
    const ctrl = new AbortController();
    setExploreAbort(() => () => { ctrl.abort(); setExploreLoading(false); });
    try {
      const sys = `You are a senior career strategist specializing in Creative/Design, Marketing/Communications, and Business/Operations. Candidate background:\n\n${ctx}\n\nGoals: ${goals || "not specified"}\nWork style: ${workStyle || "not specified"}\nPreferred companies: ${coNames || "none"}`;
      const result = await callClaude(sys, `Based on my FULL background above, provide:

1. TOP 10 BEST-FIT JOB TITLES — ranked by fit. For each: title + 1-line reason.
2. 20 ATS KEYWORDS — pulled from my actual skills and target roles.
3. 5 BOOLEAN SEARCH STRINGS — ready to paste into job boards.
4. PLATFORM STRATEGY — for each: ${(profile.platforms || []).slice(0, 8).join(", ")} — one specific tactic.
5. 3 ROLES TO AVOID — and exactly why.

Be specific. Use my actual experience.`, 3500, chunk => setExploreOutput(chunk), ctrl.signal);
      setExploreOutput(result);
    } catch (e) { if (e.name !== "AbortError") setExploreOutput("Error — please retry."); }
    setExploreLoading(false);
  };

  const runPivot = async () => {
    if (!hasProfile) { alert("Please fill in your profile first."); return; }
    setPivotLoading(true); setPivotOutput("");
    const ctrl = new AbortController();
    setPivotAbort(() => () => { ctrl.abort(); setPivotLoading(false); });
    try {
      const sys = `You are an expert career pivot strategist. Candidate background:\n\n${ctx}\n\nGoals: ${goals || "not specified"}\nWork style: ${workStyle || "not specified"}`;
      const result = await callClaude(sys, `Based on my full background, map out my best career pivot options:

1. TOP 5 PIVOT OPPORTUNITIES — for each: why it's a strong fit, what transferable skills make me competitive, what I'd need to add.
2. UNEXPECTED FITS — 2 non-obvious paths that would suit my background.
3. SKILLS BRIDGE — for my top pivot, which skills transfer and which gaps to fill.
4. TRANSITION TIMELINE — a realistic 3-step path within 6–12 months.
5. PIVOT PITCH — 2–3 sentences for cover letters/interviews to position my background as an asset.

Be specific. Use my actual experience.`, 3500, chunk => setPivotOutput(chunk), ctrl.signal);
      setPivotOutput(result);
    } catch (e) { if (e.name !== "AbortError") setPivotOutput("Error — please retry."); }
    setPivotLoading(false);
  };

  const outputData = {
    goals: { label: "PERSONAL ANALYSIS + GUIDANCE", content: goalsOutput, loading: goalsLoading, clear: () => setGoalsOutput(""), cancel: guidanceAbort },
    explore: { label: "ROLES + KEYWORDS EXPLORATION", content: exploreOutput, loading: exploreLoading, clear: () => setExploreOutput(""), cancel: exploreAbort },
    pivot: { label: "CAREER & JOB PIVOTS", content: pivotOutput, loading: pivotLoading, clear: () => setPivotOutput(""), cancel: pivotAbort },
  };

  const onOutputDragStart = (e, idx) => { dragOutputRef.current = idx; e.dataTransfer.effectAllowed = "move"; };
  const onOutputDragEnter = (e, idx) => { dragOutputOverRef.current = idx; };
  const onOutputDrop = () => {
    const from = dragOutputRef.current; const to = dragOutputOverRef.current;
    if (from == null || to == null || from === to) return;
    const next = [...outputOrder]; next.splice(to, 0, next.splice(from, 1)[0]);
    setOutputOrder(next);
    dragOutputRef.current = null; dragOutputOverRef.current = null;
  };

  return (
    <div>
      <div style={{ marginBottom: 4 }}>
        <SectionTitle>Career Development & Exploration</SectionTitle>
      </div>
      <SectionSub>AI-powered guidance using your full profile. Add goals and work style below for the most personalized output.</SectionSub>

      {!hasProfile && (
        <Panel style={{ background: T.amberBg, border: `1px solid ${T.amber}55`, marginBottom: 20 }}>
          <span style={{ color: T.amber, fontFamily: T.fontVT, fontSize: 13 }}>◈ Fill in your Job Seeker Profile first — the more detail you add, the better the output.</span>
        </Panel>
      )}

      <Panel style={{ marginBottom: 22 }}>
        <div className="grid-2" style={{ gap: 14, marginBottom: 14 }}>
          <div>
            <FieldLabel>Target Roles</FieldLabel>
            <AutocompleteTagAdder
              items={profile.savedRoles || []}
              onAdd={r => setProfile(p => ({ ...p, savedRoles: [...(p.savedRoles || []), r] }))}
              onRemove={i => setProfile(p => ({ ...p, savedRoles: (p.savedRoles || []).filter((_, j) => j !== i) }))}
              placeholder="e.g. Brand Strategist, Creative Dir..."
              color={T.amber}
              suggestions={ROLE_SUGGESTIONS} />
          </div>
          <div>
            <FieldLabel>Target Industries</FieldLabel>
            <AutocompleteTagAdder
              items={profile.savedIndustries || []}
              onAdd={r => setProfile(p => ({ ...p, savedIndustries: [...(p.savedIndustries || []), r] }))}
              onRemove={i => setProfile(p => ({ ...p, savedIndustries: (p.savedIndustries || []).filter((_, j) => j !== i) }))}
              placeholder="e.g. Tech, Nonprofit, CPG, Agency..."
              color={T.accentLight}
              suggestions={INDUSTRY_SUGGESTIONS} />
          </div>
        </div>
        <div className="grid-2" style={{ gap: 14 }}>
          <TextArea label="Goals" value={goals} onChange={setGoals} rows={3}
            placeholder="e.g. Move into a director-level role within 2 years, work remotely, break into the tech industry, increase comp by 30%..." />
          <TextArea label="Work Style & Preferences" value={workStyle} onChange={setWorkStyle} rows={3}
            placeholder="e.g. Collaborative teams, creative autonomy, fast-paced environment, mission-driven org, hybrid schedule..." />
        </div>
      </Panel>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 28, alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button onClick={runExplore} disabled={exploreLoading}
            style={{ background: exploreLoading ? T.borderLight : "#2e5f8a", color: exploreLoading ? T.textFaint : "#fff", border: `1px solid #2e5f8a`, borderRadius: 2, padding: "9px 18px", fontSize: 12, fontFamily: T.fontVT, letterSpacing: 0.8, cursor: exploreLoading ? "not-allowed" : "pointer", boxShadow: exploreLoading ? "none" : T.shadow, whiteSpace: "nowrap" }}>
            {exploreLoading ? "[ PROCESSING... ]" : "[ EXPLORE ROLES + KEYWORDS ✦ ]"}
          </button>
          <button onClick={runGuidance} disabled={goalsLoading}
            style={{ background: goalsLoading ? T.borderLight : "#4777a0", color: goalsLoading ? T.textFaint : "#fff", border: `1px solid #4777a0`, borderRadius: 2, padding: "9px 18px", fontSize: 12, fontFamily: T.fontVT, letterSpacing: 0.8, cursor: goalsLoading ? "not-allowed" : "pointer", boxShadow: goalsLoading ? "none" : T.shadow, whiteSpace: "nowrap" }}>
            {goalsLoading ? "[ PROCESSING... ]" : "[ PERSONAL ANALYSIS + GUIDANCE ✦ ]"}
          </button>
          <button onClick={runPivot} disabled={pivotLoading}
            style={{ background: pivotLoading ? T.borderLight : "#5f8fb5", color: pivotLoading ? T.textFaint : "#fff", border: `1px solid #5f8fb5`, borderRadius: 2, padding: "9px 18px", fontSize: 12, fontFamily: T.fontVT, letterSpacing: 0.8, cursor: pivotLoading ? "not-allowed" : "pointer", boxShadow: pivotLoading ? "none" : T.shadow, whiteSpace: "nowrap" }}>
            {pivotLoading ? "[ PROCESSING... ]" : "[ CAREER & JOB PIVOTS ✦ ]"}
          </button>
        </div>
        <button onClick={() => {
          setGoals(""); setWorkStyle(""); setGoalsOutput(""); setExploreOutput(""); setPivotOutput("");
          try { localStorage.setItem("career-dev-state", JSON.stringify({ goals: "", workStyle: "", goalsOutput: "", exploreOutput: "", pivotOutput: "" })); } catch {}
        }} style={{ background: T.redBg, color: T.red, border: `1px solid ${T.red}55`, borderRadius: 2, padding: "5px 12px", fontSize: 11, fontFamily: T.fontVT, letterSpacing: 0.8, cursor: "pointer", boxShadow: T.shadow, whiteSpace: "nowrap" }}>[ CLEAR ALL ]</button>
      </div>

      {/* Draggable output boxes */}
      <div onDragOver={e => e.preventDefault()}>
        {outputOrder.map((key, idx) => {
          const d = outputData[key];
          if (!d.content && !d.loading) return null;
          return (
            <div key={key} draggable
              onDragStart={e => onOutputDragStart(e, idx)}
              onDragEnter={e => onOutputDragEnter(e, idx)}
              onDrop={onOutputDrop}
              onDragOver={e => e.preventDefault()}
              style={{ marginBottom: 22, cursor: "grab" }}>
              <div style={{ color: T.textMuted, fontSize: 10, fontFamily: T.fontVT, letterSpacing: 1.5, marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: T.textFaint, opacity: 0.5 }}>⠿</span>
                {d.label}
              </div>
              <AIOutput content={d.content} loading={d.loading} onClear={d.clear} onCancel={d.cancel} />
            </div>
          );
        })}
      </div>
    </div>
  );
});

// ── MAIN APP ──────────────────────────────────────────────────────────────────
const TABS = [
  { id: "profile",   label: "Job Seeker Profile",  icon: "◉" },
  { id: "tracker",   label: "Application Tracker",  icon: "◫" },
  { id: "filegen",   label: "File Generator",       icon: "◧" },
  { id: "interview", label: "Interview Prep",       icon: "◎" },
  { id: "career",    label: "Career Development",   icon: "✦" },
];

const DEFAULT_PROFILE = {
  resumeFileName: "", coverTemplate: "", coverFileName: "", linkedin: "", portfolio: "",
  name: "", summary: "", keywords: "", strengths: "", avatar: "", avatars: [],
  experience: [{ role: "", company: "", dates: "", details: "" }],
  education: [{ degree: "", areaOfStudy: "", school: "", dates: "" }],
  savedRoles: [], savedIndustries: [],
  platforms: ["LinkedIn", "Creative People", "Robert Half", "Creative Circle", "AMA Job Board", "UT Austin Job Board"],
  preferredCompanies: []
};

export default function JobPilot() {
  const [screen, setScreen] = useState("welcome");
  const [activeTab, setActiveTab] = useState("profile");
  const [fileGenJob, setFileGenJob] = useState(null);
  const [interviewJob, setInterviewJob] = useState(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [profile, setProfile] = useState(DEFAULT_PROFILE);
  const [profileHistory, setProfileHistory] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const historyDebounce = useRef(null);

  const setProfileWithHistory = (updater) => {
    setProfile(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      clearTimeout(historyDebounce.current);
      historyDebounce.current = setTimeout(() => {
        setProfileHistory(h => [...h.slice(-19), prev]);
        setRedoStack([]); // Clear redo stack on new change
      }, 800);
      return next;
    });
  };

  const handleUndo = () => {
    if (profileHistory.length === 0) return;
    const prev = profileHistory[profileHistory.length - 1];
    setRedoStack(r => [...r, profile]); // Save current to redo stack
    setProfileHistory(h => h.slice(0, -1));
    setProfile(prev);
  };

  const handleRedo = () => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setProfileHistory(h => [...h, profile]); // Save current to history
    setRedoStack(r => r.slice(0, -1));
    setProfile(next);
  };

  useEffect(() => {
    (async () => {
      try {
        const stored = localStorage.getItem("profile");
        if (stored) {
          const s = JSON.parse(stored);
          if (s.resume && !s.summary) s.summary = s.resume.slice(0, 500);
          if (!s.experience) s.experience = [{ role: "", company: "", dates: "", details: "" }];
          if (!s.education) s.education = [{ degree: "", areaOfStudy: "", school: "", dates: "" }];
          if (!s.keywords) s.keywords = "";
          if (!s.strengths) s.strengths = "";
          if (!s.name) s.name = "";
          if (!s.boardOrder) s.boardOrder = PLATFORMS;
          if (!s.removedBuiltIn) s.removedBuiltIn = [];
          if (!s.avatars) s.avatars = s.avatar ? [s.avatar] : [];
          // Migrate education entries to include areaOfStudy
          if (s.education) s.education = s.education.map(e => ({ areaOfStudy: "", ...e }));
          setProfile(s);
          const isFilledOut = s.resumeFileName || (s.summary && s.summary.trim().length > 20) || (s.experience && s.experience.some(e => e.role || e.company));
          if (isFilledOut) { setScreen("app"); setActiveTab("tracker"); }
        }
      } catch {}
      setProfileLoaded(true);
    })();
  }, []);

  // PERFORMANCE FIX: Debounced storage writes instead of on every change
  // Only saves after 500ms of inactivity - prevents excessive API calls
  useDebouncedStorage("profile", profileLoaded ? profile : null, 500);

  const handleSetFileGenJob = (job) => { setFileGenJob(job); setActiveTab("filegen"); };
  const handleInterviewJob = (job) => { setInterviewJob(job); setActiveTab("interview"); };

  if (screen === "terms") return <TermsPage onBack={() => setScreen("welcome")} />;
  if (screen === "welcome") return <WelcomePage onEnter={() => setScreen("app")} onGetStarted={() => { setScreen("app"); setActiveTab("profile"); setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 120); }} onGoToTab={(tab) => { setScreen("app"); setActiveTab(tab); setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 120); }} onShowTerms={() => setScreen("terms")} />;
  if (!profileLoaded) return <div style={{ minHeight: "100vh", background: T.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: T.fontVT }}><div style={{ color: T.textFaint, fontSize: 20, letterSpacing: 2 }}>loading...</div></div>;

  return (
    <div style={{ minHeight: "100vh", background: T.bg, fontFamily: T.fontMono }}>
      <link href="https://fonts.googleapis.com/css2?family=VT323&display=swap" rel="stylesheet" />
      <style>{`
        * { box-sizing: border-box; } body { background: ${T.bg}; margin: 0; }
        ::-webkit-scrollbar { width: 8px; height: 8px; } ::-webkit-scrollbar-track { background: ${T.bgInset}; border-left: 1px solid ${T.border}; } ::-webkit-scrollbar-thumb { background: ${T.border}; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.25} } @keyframes blink { 0%,49%{opacity:1} 50%,100%{opacity:0} } @keyframes fadeIn { from{opacity:0;transform:translateY(5px)} to{opacity:1;transform:translateY(0)} }
        input::placeholder, textarea::placeholder { color: ${T.textFaint}; } select option { background: ${T.bgPanel}; color: ${T.textPrimary}; }
        .jp-layout { display: flex; min-height: calc(100vh - 53px); }
        .jp-sidebar { width: 220px; border-right: 2px solid ${T.border}; padding: 18px 8px; flex-shrink: 0; background: ${T.bgPanel}; }
        .jp-main { flex: 1; padding: 30px 34px; overflow-y: auto; animation: fadeIn .2s ease; }
        .jp-bottom-nav { display: none; }
        .jp-header-sub { display: flex; }
        .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
        .grid-3-boards { display: grid; grid-template-columns: repeat(3,1fr); gap: 6px; }
        .grid-form-3 { display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: flex-end; }
        .sticky-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 12px; }
        @media(min-width:701px) and (max-width:1024px) {
          .jp-sidebar { width: 130px; padding: 14px 6px; }
          .jp-sidebar button { font-size: 13px !important; padding: 8px 8px !important; }
          .jp-main { padding: 20px 20px; }
          .grid-2 { grid-template-columns: 1fr 1fr; }
          .grid-3-boards { grid-template-columns: repeat(2,1fr); }
          .sticky-grid { grid-template-columns: repeat(2,1fr); }
          .tracker-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
          .tracker-scroll > * { min-width: 600px; }
        }
        @media(max-width:700px) {
          .jp-sidebar { display: none; } .jp-bottom-nav { display: flex; position: fixed; bottom: 0; left: 0; right: 0; z-index: 200; background: ${T.bgPanel}; border-top: 2px solid ${T.border}; justify-content: space-around; padding: 6px 0 env(safe-area-inset-bottom); }
          .jp-layout { min-height: calc(100vh - 53px - 60px); } .jp-main { padding: 18px 16px 80px; } .jp-header-sub { display: none; }
          .grid-2 { grid-template-columns: 1fr; } .grid-3-boards { grid-template-columns: repeat(2,1fr); }
          .grid-form-3 { grid-template-columns: 1fr 1fr; } .grid-form-3>*:last-child { grid-column: 1/-1; } .sticky-grid { grid-template-columns: repeat(2,1fr); }
          .tracker-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
          .tracker-scroll > * { min-width: 640px; }
          .tracker-scroll input, .tracker-scroll select { font-size: 13px !important; }
          .tracker-scroll div[style*="fontSize: 9"], .tracker-scroll div[style*="fontSize: 10"], .tracker-scroll div[style*="fontSize: 11"] { font-size: 13px !important; }
        }
      `}</style>

      {/* Header */}
      <div style={{ borderBottom: `2px solid ${T.border}`, padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", background: T.bgPanel, boxShadow: `0 2px 0 ${T.borderLight}`, position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <button onClick={() => setScreen("welcome")} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
            <div style={{ display: "flex", alignItems: "baseline" }}><span style={{ fontFamily: T.fontVT, fontSize: 30, color: T.textPrimary, letterSpacing: 3 }}>JOB</span><span style={{ fontFamily: T.fontVT, fontSize: 30, color: T.accent, letterSpacing: 3 }}>PILOT</span></div>
            <span style={{ fontFamily: T.fontVT, fontSize: 11, color: T.textFaint, letterSpacing: 2, lineHeight: 1, marginTop: -2, alignSelf: "flex-end" }}>beta</span>
          </button>
          <span className="jp-header-sub" style={{ color: T.textFaint, fontSize: 11, fontFamily: T.fontVT, letterSpacing: 2, borderLeft: `1px solid ${T.border}`, paddingLeft: 12, marginLeft: 12 }}>AI-POWERED APPLICATION ASSISTANT (v4.1)</span>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button onClick={handleUndo} disabled={profileHistory.length === 0} title="Undo last profile change" style={{ background: "transparent", border: `1px solid ${T.border}`, borderRadius: 2, color: profileHistory.length > 0 ? T.textFaint : T.borderLight, fontSize: 10, fontFamily: T.fontVT, padding: "3px 10px", cursor: profileHistory.length > 0 ? "pointer" : "not-allowed", letterSpacing: 0.5 }}>↩ UNDO</button>
          <button onClick={handleRedo} disabled={redoStack.length === 0} title="Redo profile change" style={{ background: "transparent", border: `1px solid ${T.border}`, borderRadius: 2, color: redoStack.length > 0 ? T.textFaint : T.borderLight, fontSize: 10, fontFamily: T.fontVT, padding: "3px 10px", cursor: redoStack.length > 0 ? "pointer" : "not-allowed", letterSpacing: 0.5 }}>↪ REDO</button>
          <span style={{ background: T.accentBg, border: `1px solid ${T.accent}44`, color: T.accent, borderRadius: 2, padding: "2px 10px", fontSize: 10, fontFamily: T.fontVT, letterSpacing: 1 }}>made by wendi x claude</span>
        </div>
      </div>

      <div className="jp-layout">
        {/* Sidebar */}
        <div className="jp-sidebar" style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1 }}>
            <div style={{ color: T.textFaint, fontSize: 9, fontFamily: T.fontVT, letterSpacing: 1.5, padding: "6px 12px 4px", marginBottom: 2 }}>TOOLS</div>
            {TABS.map(tab => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", border: "none", cursor: "pointer", marginBottom: 1, background: activeTab === tab.id ? T.accentBg : "transparent", color: activeTab === tab.id ? T.accent : T.textMuted, fontFamily: T.fontVT, fontSize: 16, textAlign: "left", letterSpacing: 0.8, borderLeft: activeTab === tab.id ? `3px solid ${T.accent}` : "3px solid transparent", transition: "all .1s" }}>
                <span>{tab.icon}</span><span>{tab.label}</span>
              </button>
            ))}
          </div>
          <div style={{ padding: "12px", borderTop: `1px solid ${T.border}` }}>
            <button onClick={() => setScreen("welcome")} style={{ width: "100%", background: "transparent", border: `1px solid ${T.border}`, borderRadius: 2, color: T.textFaint, fontSize: 11, fontFamily: T.fontVT, padding: "6px 10px", cursor: "pointer", letterSpacing: 0.5 }}>← WELCOME</button>
          </div>
        </div>

        {/* Main */}
        <div className="jp-main">
          {activeTab === "profile"   && <ProfileTab profile={profile} setProfile={setProfileWithHistory} />}
          {activeTab === "career"    && <CareerDevTab profile={profile} setProfile={setProfileWithHistory} />}
          {activeTab === "tracker"   && <TrackerTab profile={profile} setActiveTab={setActiveTab} setFileGenJob={handleSetFileGenJob} setInterviewJob={handleInterviewJob} />}
          {activeTab === "filegen"   && <FileGenTab profile={profile} prefillJob={fileGenJob} />}
          {activeTab === "interview" && <InterviewTab profile={profile} prefillJob={interviewJob} />}
        </div>
      </div>

      {/* Bottom nav — mobile */}
      <div className="jp-bottom-nav">
        {TABS.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "6px 4px", border: "none", background: "transparent", cursor: "pointer", color: activeTab === tab.id ? T.accent : T.textFaint, borderTop: activeTab === tab.id ? `2px solid ${T.accent}` : "2px solid transparent" }}>
            <span style={{ fontSize: 16 }}>{tab.icon}</span>
            <span style={{ fontSize: 8, fontFamily: T.fontVT, letterSpacing: 0.5, whiteSpace: "nowrap" }}>{tab.label.split(" ")[0].toUpperCase()}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

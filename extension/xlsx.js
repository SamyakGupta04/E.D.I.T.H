// A small .xlsx writer (no library) and the rules that turn a log entry into
// company, position and public job link. Used by the popup's "Download Excel".
(() => {
  // ---------- log entry -> company, position, job link ----------
  const nice = (s) => decodeURIComponent(s || "").replace(/[-_]+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());

  function normalize(url, title, company) {
    let u;
    try { u = new URL(url); } catch (e) { return { site: "", company: company || "", position: title || "", link: url || "" }; }
    const parts = u.pathname.split("/").filter(Boolean);
    title = (title || "").trim();
    let site = "", link = url, comp = company || "", pos = title;
    if (/ashbyhq\.com$/.test(u.hostname)) {
      site = "Ashby"; link = url.replace(/\/application\/?$/, ""); comp = nice(parts[0]);
      const i = title.lastIndexOf(" @ ");
      if (i > 0) { pos = title.slice(0, i); comp = title.slice(i + 3).trim() || comp; }
    } else if (/greenhouse\.io$/.test(u.hostname)) {
      site = "Greenhouse";
      const org = u.searchParams.get("for"), id = u.searchParams.get("token");
      if (org && id) { link = `https://job-boards.greenhouse.io/${org}/jobs/${id}`; comp = nice(org); }
      else if (parts[0]) comp = nice(parts[0]);
      const m = title.match(/^Job Application for (.+) at (.+)$/);
      if (m) { pos = m[1].trim(); comp = m[2].trim(); }
    } else if (/lever\.co$/.test(u.hostname)) {
      site = "Lever"; link = url.replace(/\/apply\/?$/, ""); comp = nice(parts[0]);
      const m = title.match(/^(.+?) - (.+)$/);
      if (m) { comp = m[1].trim(); pos = m[2].trim(); }
    } else if (/workable\.com$/.test(u.hostname)) {
      site = "Workable"; link = url.replace(/\/apply\/?$/, "/"); comp = nice(parts[0]);
      const m = title.match(/^(.+?) - (.+)$/);
      if (m) { pos = m[1].trim(); comp = m[2].trim() || comp; }
    } else if (/keka\.com$/.test(u.hostname)) {
      site = "Keka"; comp = nice(u.hostname.split(".")[0]);
    }
    return { site, company: comp, position: pos.trim(), link };
  }

  // One row for each job: a submitted entry wins, then the newest entry.
  function mergeApplications(entries) {
    const rows = new Map();
    for (const e of entries) {
      if (!e.url || /\/00000000-0000-4000-/.test(e.url)) continue; // test entries
      const n = normalize(e.url, e.title, e.company);
      const key = n.link.toLowerCase();
      const old = rows.get(key);
      const time = new Date(e.time);
      if (old) {
        if (old.status === "submitted" && e.status !== "submitted") continue;
        if (old.status === e.status && old.time >= time) continue;
        if (old.status !== "submitted" && e.status !== "submitted" && old.time >= time) continue;
      }
      rows.set(key, { ...n, status: e.status, time, detail: e.detail || e.note || "" });
    }
    return [...rows.values()].sort((a, b) => b.time - a.time);
  }

  // ---------- .xlsx ----------
  const esc = (s) => String(s ?? "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const colName = (i) => (i >= 26 ? String.fromCharCode(64 + Math.floor(i / 26)) : "") + String.fromCharCode(65 + (i % 26));

  // sheet: { name, widths: [..], rows: [[cell, ..], ..] }. A cell is text, or
  // { link: url } for a clickable link. Row 1 is the header.
  function sheetXml(sheet) {
    const rows = sheet.rows.map((row, r) => `<row r="${r + 1}">` + row.map((cell, c) => {
      const ref = colName(c) + (r + 1);
      if (cell && typeof cell === "object" && cell.link) {
        const url = String(cell.link).replace(/"/g, "%22").slice(0, 250);
        return `<c r="${ref}" t="str" s="2"><f>HYPERLINK("${esc(url)}")</f><v>${esc(url)}</v></c>`;
      }
      return `<c r="${ref}" t="inlineStr"${r === 0 ? ' s="1"' : ""}><is><t xml:space="preserve">${esc(cell)}</t></is></c>`;
    }).join("") + "</row>").join("");
    const cols = (sheet.widths || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
    const last = colName(Math.max(0, (sheet.rows[0] || []).length - 1)) + Math.max(1, sheet.rows.length);
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
      `<cols>${cols}</cols><sheetData>${rows}</sheetData><autoFilter ref="A1:${last}"/></worksheet>`;
  }

  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

  // A zip file with stored (not compressed) entries.
  function zip(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    let offset = 0;
    const u16 = (n) => [n & 255, (n >>> 8) & 255], u32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
    for (const [name, text] of files) {
      const nameB = enc.encode(name), data = enc.encode(text), crc = crc32(data);
      const head = [...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nameB.length), ...u16(0)];
      parts.push(new Uint8Array(head), nameB, data);
      central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length),
        ...u16(nameB.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), nameB);
      offset += head.length + nameB.length + data.length;
    }
    const cSize = central.reduce((n, b) => n + b.length, 0);
    const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cSize), ...u32(offset), ...u16(0)]);
    return new Blob([...parts, ...central, end], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  function workbook(sheets) {
    const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    const files = [
      ["[Content_Types].xml", `${X}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`],
      ["_rels/.rels", `${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
      ["xl/workbook.xml", `${X}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`],
      ["xl/_rels/workbook.xml.rels", `${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
      // style 0: normal. 1: bold header. 2: blue underlined link.
      ["xl/styles.xml", `${X}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><u/><sz val="11"/><color rgb="FF1D4ED8"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf fontId="0"/><xf fontId="1" applyFont="1"/><xf fontId="2" applyFont="1"/></cellXfs></styleSheet>`],
      ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
    ];
    return zip(files);
  }

  globalThis.EdithXlsx = { workbook, normalize, mergeApplications };
})();

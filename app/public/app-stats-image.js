// PNG export reads the rendered dashboard: cards, language, chart axis and
// rank metric stay identical to the page. Canvas avoids external resources
// and SVG foreignObject restrictions on touch browsers.
let statsImageToken = 0;
let statsImageUrl = null;
let statsImageFile = null;
let statsImageAvailable = false;

function closeStatsImage() {
  statsImageToken += 1;
  if (statsImageUrl) URL.revokeObjectURL(statsImageUrl);
  statsImageUrl = null;
  statsImageFile = null;
  const button = document.getElementById("passport-image");
  if (button) button.disabled = !statsImageAvailable;
  const status = document.getElementById("passport-image-status");
  if (status) status.textContent = "";
  const download = document.getElementById("passport-image-download");
  if (download) download.removeAttribute("href");
  const preview = document.getElementById("passport-image-preview");
  if (preview) preview.hidden = true;
  const img = document.getElementById("passport-image-result");
  if (img) img.removeAttribute("src");
}

function statsImageSnapshot() {
  const text = (element, selector) => element.querySelector(selector)?.textContent.trim() || "";
  const tickets = [...document.querySelectorAll("#stats-daily .ticket-face")].map((face) => ({
    title: text(face, ".ticket-kind"), scope: text(face, ".ticket-scope"),
    distanceLabel: text(face, ".ticket-distance .ticket-display-label"),
    distance: text(face, ".ticket-distance strong"),
    durationLabel: text(face, ".ticket-duration .ticket-display-label"),
    duration: text(face, ".ticket-duration strong"),
    fields: [...face.querySelectorAll(".ticket-field")].map((field) => ({
      label: text(field, ".ticket-field-label"), value: text(field, ".ticket-field-value"),
    })),
    span: text(face, ".ticket-span"), footer: text(face, ".ticket-footer"),
  }));
  const cards = [...document.querySelectorAll("#stats-headline .passport-stat-card")].map((card) => ({
    title: text(card, "h3"),
    rows: [...card.querySelectorAll(".passport-stat-metric, .passport-stat-journey, .passport-stat-rank")]
      .filter((row) => !row.closest("details"))
      .map((row) => ({
        label: row.querySelector("span")?.textContent.trim() || "",
        value: row.querySelector(row.matches(".passport-stat-journey") ? "b" : "strong")?.textContent.trim() || "",
      })),
    chart: [...card.querySelectorAll(".passport-stat-column")].map((column) => ({
      label: text(column, "small"), count: Number(text(column, "span")) || 0,
    })),
    notes: [...card.querySelectorAll(".passport-stat-year, .passport-stat-highlight, .passport-stat-note")]
      .map((row) => row.matches(".passport-stat-year") ? row.querySelector("select")?.value : row.textContent.trim()).filter(Boolean),
  }));
  const hero = document.querySelector("#stats-headline .stats-hero");
  if (hero) cards.push({ title: I18N.t("stats.coverageTitle"), rows: [{ label: text(hero, ".stats-sub"), value: text(hero, ".stats-pct") }], chart: [], notes: [] });
  return { tickets, cards, scope: `${I18N.t(`country.${activeCountry}`)} · ${passportScopeDate === ALL_DATES ? I18N.t("date.all") : dateLabel(passportScopeDate)}` };
}

function drawStatsImage(snapshot) {
  const width = 1020;
  const cardHeights = snapshot.cards.map((card) => 100 + card.rows.length * 66 + card.notes.length * 38 + (card.chart.length ? 230 : 0));
  const height = 150 + snapshot.tickets.length * 710 + cardHeights.reduce((sum, value) => sum + value + 24, 0);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(I18N.t("passport.imageFailed"));
  ctx.fillStyle = "#f3f1ec";
  ctx.fillRect(0, 0, width, height);
  const fittedText = (value, x, y, size, maxWidth, family = "sans-serif") => {
    ctx.font = `${size}px ${family}`;
    ctx.fillText(String(value), x, y, maxWidth);
  };
  ctx.fillStyle = "#252b34";
  fittedText(I18N.t("nav.passport"), 48, 58, 34, 924);
  fittedText(snapshot.scope, 48, 105, 25, 924);
  let y = 140;
  for (const ticket of snapshot.tickets) {
    ctx.save();
    ctx.translate(0, y);
    ctx.scale(2, 2);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 510, 345);
    ctx.strokeStyle = "rgba(31,143,224,.10)";
    for (let line = -345; line < 900; line += 9) {
      ctx.beginPath(); ctx.moveTo(line, 0); ctx.lineTo(line - 92, 345); ctx.stroke();
    }
    ctx.fillStyle = "rgba(31,143,224,.28)";
    ctx.fillRect(0, 239, 510, 35);
    ctx.fillStyle = "#000";
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 2;
    ctx.strokeRect(42, 43, 30, 22);
    const font = '"JRM Unifont", monospace';
    fittedText("RM", 46, 60, 16, 23, font);
    fittedText(ticket.title, 120, 63, 25, 255, font);
    fittedText(ticket.scope, 380, 61, 15, 85, font);
    ctx.fillRect(192, 79, 126, 2);
    fittedText(ticket.distanceLabel, 58, 106, 18, 190, font);
    fittedText(ticket.durationLabel, 272, 106, 18, 190, font);
    fittedText(ticket.distance, 58, 142, 34, 190, font);
    fittedText(ticket.duration, 272, 142, 31, 190, font);
    ticket.fields.forEach((field, index) => {
      const x = index % 2 ? 288 : 44;
      const rowY = 174 + Math.floor(index / 2) * 26;
      fittedText(`${field.label} ${field.value}`, x, rowY, 18, index % 2 ? 177 : 230, font);
    });
    fittedText(ticket.span, 44, 225, 16, 423, font);
    fittedText(ticket.footer, 44, 312, 15, 423, font);
    ctx.restore();
    y += 710;
  }
  snapshot.cards.forEach((card, index) => {
    const h = cardHeights[index];
    ctx.fillStyle = "#fff";
    ctx.fillRect(28, y, 964, h);
    ctx.fillStyle = "#252b34";
    fittedText(card.title, 56, y + 45, 30, 900);
    let rowY = y + 90;
    for (const note of card.notes) { fittedText(note, 56, rowY, 23, 900); rowY += 38; }
    if (card.chart.length) {
      const max = Math.max(1, ...card.chart.map((column) => column.count));
      const step = 900 / card.chart.length;
      card.chart.forEach((column, columnIndex) => {
        const x = 56 + step * columnIndex;
        const barH = Math.max(2, 150 * column.count / max);
        ctx.fillStyle = "#d47a2b";
        ctx.fillRect(x + step * .25, rowY + 165 - barH, step * .5, barH);
        ctx.fillStyle = "#252b34";
        fittedText(column.count || "", x, rowY + 155 - barH, 21, step - 4);
        fittedText(column.label, x, rowY + 198, 21, step - 4);
      });
      rowY += 230;
    }
    for (const row of card.rows) {
      fittedText(row.label, 56, rowY, 24, 610);
      ctx.textAlign = "right";
      fittedText(row.value, 964, rowY, 27, 260);
      ctx.textAlign = "left";
      rowY += 66;
    }
    y += h + 24;
  });
  return canvas;
}

function bindStatsImage(view) {
  const button = document.getElementById("passport-image");
  if (!button) return;
  statsImageAvailable = view.ticket.rideCount > 0;
  closeStatsImage();
  button.disabled = !statsImageAvailable;
  if (button.dataset.bound) return;
  button.dataset.bound = "true";
  const status = document.getElementById("passport-image-status");
  document.getElementById("passport-image-close").addEventListener("click", closeStatsImage);
  document.getElementById("passport-image-share").addEventListener("click", async () => {
    if (!statsImageFile) return;
    try { await navigator.share({ files: [statsImageFile], title: I18N.t("nav.passport") }); }
    catch (error) { if (error.name !== "AbortError") status.textContent = I18N.t("passport.imageFailed"); }
  });
  button.addEventListener("click", async () => {
    closeStatsImage();
    const token = statsImageToken;
    const country = activeCountry;
    const snapshot = statsImageSnapshot();
    button.disabled = true;
    status.textContent = I18N.t("passport.imageLoading");
    try {
      await document.fonts.load('25px "JRM Unifont"');
      const canvas = drawStatsImage(snapshot);
      const blob = await new Promise((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error("PNG")), "image/png"));
      if (token !== statsImageToken || country !== activeCountry) return;
      statsImageFile = new File([blob], `rail-passport-${country}.png`, { type: "image/png" });
      statsImageUrl = URL.createObjectURL(blob);
      const img = document.getElementById("passport-image-result");
      img.src = statsImageUrl;
      img.alt = `${I18N.t("nav.passport")} · ${snapshot.scope}`;
      const download = document.getElementById("passport-image-download");
      download.href = statsImageUrl;
      download.download = statsImageFile.name;
      document.getElementById("passport-image-share").hidden = !navigator.canShare?.({ files: [statsImageFile] });
      document.getElementById("passport-image-preview").hidden = false;
      status.textContent = "";
    } catch { if (token === statsImageToken) status.textContent = I18N.t("passport.imageFailed"); }
    finally { if (token === statsImageToken) button.disabled = false; }
  });
}

const formatNumber = new Intl.NumberFormat("de-DE");
const formatEuro = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const map = L.map("map", { zoomControl: false }).setView([52.515, 13.405], 10);
L.control.zoom({ position: "bottomleft" }).addTo(map);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);

const filterIds = ["dateFrom", "dateTo", "districtFilter", "regionFilter", "bikeFilter", "offenseFilter", "attemptFilter"];
const filterElements = Object.fromEntries(filterIds.map(id => [id, document.getElementById(id)]));
const areaById = new Map();
const totalsByArea = new Map();
let incidents = [];
let areaFeatures = [];
let maxCases = 0;
let selectedAreaId = "";
let geoLayer;
let berlinBounds;

function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (quoted) {
            if (char === '"' && text[i + 1] === '"') {
                cell += '"';
                i++;
            } else if (char === '"') {
                quoted = false;
            } else {
                cell += char;
            }
        } else if (char === '"') {
            quoted = true;
        } else if (char === ",") {
            row.push(cell);
            cell = "";
        } else if (char === "\n" || char === "\r") {
            if (char === "\r" && text[i + 1] === "\n") i++;
            row.push(cell);
            if (row.some(value => value !== "")) rows.push(row);
            row = [];
            cell = "";
        } else {
            cell += char;
        }
    }
    if (cell || row.length) {
        row.push(cell);
        if (row.some(value => value !== "")) rows.push(row);
    }
    const headers = rows.shift().map(value => value.trim());
    return rows.map(values => Object.fromEntries(headers.map((header, i) => [header, (values[i] || "").trim()])));
}

function toIsoDate(value) {
    const [day, month, year] = value.split(".");
    return `${year}-${month}-${day}`;
}

function appendOptions(select, values, placeholder) {
    const first = select.options[0];
    first.textContent = placeholder;
    for (const value of values) {
        const option = document.createElement("option");
        option.value = value.value;
        option.textContent = value.label;
        select.appendChild(option);
    }
}

function setRegionOptions() {
    const district = filterElements.districtFilter.value;
    const region = filterElements.regionFilter;
    const previous = region.value;
    region.replaceChildren();
    const allOption = document.createElement("option");
    allOption.value = "";
    allOption.textContent = "Alle Bezirksregionen";
    region.appendChild(allOption);
    const regions = new Map();
    for (const feature of areaFeatures) {
        const properties = feature.properties;
        if ((!district || properties.bez === district) && properties.bzr_id && properties.bzr_name) {
            regions.set(properties.bzr_id, `${properties.bzr_name} · ${properties.bez.replace(/^\d+\s*-\s*/, "")}`);
        }
    }
    for (const [value, label] of [...regions].sort((a, b) => a[1].localeCompare(b[1], "de"))) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        region.appendChild(option);
    }
    region.value = [...region.options].some(option => option.value === previous) ? previous : "";
}

function zoomToAreaFilters() {
    const district = filterElements.districtFilter.value;
    const region = filterElements.regionFilter.value;
    if (!district && !region) {
        if (berlinBounds) map.fitBounds(berlinBounds, { padding: [26, 26] });
        return;
    }

    let bounds;
    for (const feature of areaFeatures) {
        const properties = feature.properties;
        if ((district && properties.bez !== district) || (region && properties.bzr_id !== region)) continue;
        const layer = areaById.get(properties.plr_id)?.layer;
        if (!layer) continue;
        if (bounds) bounds.extend(layer.getBounds());
        else bounds = layer.getBounds();
    }
    if (bounds?.isValid()) {
        map.fitBounds(bounds, { padding: [36, 36], maxZoom: region ? 13 : 12 });
    }
}

function getColor(value) {
    if (!value) return "#edf0ed";
    const ratio = Math.sqrt(value / Math.max(maxCases, 1));
    if (ratio < .2) return "#f8edc9";
    if (ratio < .4) return "#f4d293";
    if (ratio < .6) return "#efaa68";
    if (ratio < .8) return "#df7050";
    return "#a92f36";
}

function styleArea(feature) {
    const id = feature.properties.plr_id;
    const count = totalsByArea.get(id)?.count || 0;
    const selected = id === selectedAreaId;
    return {
        color: selected ? "#17231f" : "#fff",
        weight: selected ? 2 : .8,
        opacity: .95,
        fillColor: getColor(count),
        fillOpacity: count ? .82 : .48
    };
}

function makePopup(feature) {
    const p = feature.properties;
    const stats = totalsByArea.get(p.plr_id) || { count: 0, damage: 0, bikes: new Map() };
    const topBike = [...stats.bikes].sort((a, b) => b[1] - a[1])[0];
    const popup = document.createElement("div");
    popup.className = "popup";
    const title = document.createElement("h3");
    title.textContent = p.plr_name || "Planungsraum";
    const caption = document.createElement("div");
    caption.className = "popup-caption";
    caption.textContent = `${p.bzr_name} · ${p.bez.replace(/^\d+\s*-\s*/, "")} · LOR ${p.plr_id}`;
    const count = document.createElement("div");
    count.className = "popup-count";
    count.textContent = formatNumber.format(stats.count);
    const small = document.createElement("small");
    small.textContent = " Fälle";
    count.appendChild(small);
    popup.append(title, caption, count);
    const lines = [
        ["Erfasster Schaden", formatEuro.format(stats.damage)],
        ["Häufigster Fahrradtyp", topBike ? topBike[0] : "–"]
    ];
    for (const [label, value] of lines) {
        const line = document.createElement("div");
        line.className = "popup-line";
        const key = document.createElement("span");
        key.textContent = label;
        const result = document.createElement("strong");
        result.textContent = value;
        line.append(key, result);
        popup.appendChild(line);
    }
    return popup;
}

function selectArea(id, openPopup = false) {
    selectedAreaId = id;
    if (geoLayer) geoLayer.setStyle(styleArea);
    for (const button of document.querySelectorAll(".area-row")) {
        button.classList.toggle("selected", button.dataset.areaId === id);
    }
    if (openPopup) {
        const layer = areaById.get(id)?.layer;
        if (layer) {
            map.fitBounds(layer.getBounds(), { padding: [40, 40], maxZoom: 14 });
            layer.openPopup();
        }
    }
}

function renderRanking() {
    const list = document.getElementById("areaList");
    list.replaceChildren();
    const ranked = areaFeatures
        .map(feature => ({ feature, stats: totalsByArea.get(feature.properties.plr_id) }))
        .filter(item => item.stats?.count)
        .sort((a, b) => b.stats.count - a.stats.count || a.feature.properties.plr_name.localeCompare(b.feature.properties.plr_name, "de"));
    document.getElementById("rankingSummary").textContent = `${ranked.length} Gebiete`;
    document.getElementById("mapSubtitle").textContent = `${formatNumber.format(ranked.reduce((sum, item) => sum + item.stats.count, 0))} Fälle · Flächenfarbe nach Häufigkeit`;
    if (!ranked.length) {
        const empty = document.createElement("div");
        empty.className = "empty-list";
        empty.textContent = "Keine Fälle für diese Filterkombination. Passe den Zeitraum oder die Auswahl an.";
        list.appendChild(empty);
        return;
    }
    for (const { feature, stats } of ranked.slice(0, 8)) {
        const p = feature.properties;
        const button = document.createElement("button");
        button.type = "button";
        button.className = `area-row${p.plr_id === selectedAreaId ? " selected" : ""}`;
        button.dataset.areaId = p.plr_id;
        const name = document.createElement("span");
        const title = document.createElement("span");
        title.className = "area-name";
        title.textContent = p.plr_name || "Planungsraum";
        const subtitle = document.createElement("span");
        subtitle.className = "area-subtitle";
        subtitle.textContent = `${p.bzr_name} · ${p.bez.replace(/^\d+\s*-\s*/, "")}`;
        name.append(title, subtitle);
        const count = document.createElement("span");
        count.className = "area-count";
        count.textContent = formatNumber.format(stats.count);
        button.append(name, count);
        button.addEventListener("click", () => selectArea(p.plr_id, true));
        list.appendChild(button);
    }
}

function updateView() {
    const from = filterElements.dateFrom.value;
    const to = filterElements.dateTo.value;
    const district = filterElements.districtFilter.value;
    const region = filterElements.regionFilter.value;
    const bike = filterElements.bikeFilter.value;
    const offense = filterElements.offenseFilter.value;
    const attempt = filterElements.attemptFilter.value;
    totalsByArea.clear();
    for (const incident of incidents) {
        if ((from && incident.date < from) || (to && incident.date > to)) continue;
        if (bike && incident.ART_DES_FAHRRADS !== bike) continue;
        if (offense && incident.DELIKT !== offense) continue;
        if (attempt && incident.VERSUCH !== attempt) continue;
        const area = areaById.get(incident.LOR);
        if (!area || (district && area.properties.bez !== district) || (region && area.properties.bzr_id !== region)) continue;
        let stats = totalsByArea.get(incident.LOR);
        if (!stats) {
            stats = { count: 0, damage: 0, bikes: new Map() };
            totalsByArea.set(incident.LOR, stats);
        }
        stats.count++;
        stats.damage += Number.parseInt(incident.SCHADENSHOEHE, 10) || 0;
        stats.bikes.set(incident.ART_DES_FAHRRADS, (stats.bikes.get(incident.ART_DES_FAHRRADS) || 0) + 1);
    }
    maxCases = Math.max(0, ...[...totalsByArea.values()].map(item => item.count));
    const count = [...totalsByArea.values()].reduce((sum, stats) => sum + stats.count, 0);
    const damage = [...totalsByArea.values()].reduce((sum, stats) => sum + stats.damage, 0);
    document.getElementById("totalCount").textContent = formatNumber.format(count);
    document.getElementById("areaCount").textContent = formatNumber.format(totalsByArea.size);
    document.getElementById("damageTotal").textContent = formatEuro.format(damage);
    if (geoLayer) geoLayer.setStyle(styleArea);
    renderRanking();
}

async function loadData() {
    const [csvResponse, geoResponse] = await Promise.all([
        fetch("Fahrraddiebstahl.csv"),
        fetch("lor-2021-planungsraeume.geojson")
    ]);
    if (!csvResponse.ok || !geoResponse.ok) throw new Error("CSV oder LOR-Geodaten sind nicht erreichbar.");
    const [csvBuffer, geojson] = await Promise.all([csvResponse.arrayBuffer(), geoResponse.json()]);
    const text = new TextDecoder("windows-1252").decode(csvBuffer);
    incidents = parseCsv(text).map(row => ({ ...row, date: toIsoDate(row.TATZEIT_ANFANG_DATUM) }));
    areaFeatures = geojson.features;
    for (const feature of areaFeatures) areaById.set(feature.properties.plr_id, { properties: feature.properties });
    geoLayer = L.geoJSON(geojson, {
        style: styleArea,
        onEachFeature(feature, layer) {
            const p = feature.properties;
            const area = areaById.get(p.plr_id);
            area.layer = layer;
            layer.bindPopup(() => makePopup(feature), { maxWidth: 280 });
            layer.bindTooltip(`${p.plr_name} · ${p.bzr_name}`, { sticky: true });
            layer.on("click", () => selectArea(p.plr_id));
        }
    }).addTo(map);
    berlinBounds = geoLayer.getBounds();
    map.fitBounds(berlinBounds, { padding: [26, 26] });

    const dates = incidents.map(row => row.date).sort();
    filterElements.dateFrom.value = dates[0];
    filterElements.dateTo.value = dates[dates.length - 1];
    filterElements.dateFrom.min = dates[0];
    filterElements.dateFrom.max = dates[dates.length - 1];
    filterElements.dateTo.min = dates[0];
    filterElements.dateTo.max = dates[dates.length - 1];

    const districts = [...new Set(areaFeatures.map(feature => feature.properties.bez).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, "de"))
        .map(value => ({ value, label: value.replace(/^\d+\s*-\s*/, "") }));
    appendOptions(filterElements.districtFilter, districts, "Alle Bezirke");
    appendOptions(filterElements.bikeFilter, [...new Set(incidents.map(row => row.ART_DES_FAHRRADS).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de")).map(value => ({ value, label: value })), "Alle Fahrradtypen");
    appendOptions(filterElements.offenseFilter, [...new Set(incidents.map(row => row.DELIKT).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de")).map(value => ({ value, label: value })), "Alle Delikte");
    appendOptions(filterElements.attemptFilter, [...new Set(incidents.map(row => row.VERSUCH).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de")).map(value => ({ value, label: value })), "Alle Fälle");
    setRegionOptions();
    document.getElementById("dataPeriod").textContent = `${incidents.length.toLocaleString("de-DE")} Fälle · ${dates[0].slice(0, 4)}–${dates[dates.length - 1].slice(0, 4)}`;
    updateView();
    map.invalidateSize();
}

for (const element of Object.values(filterElements)) {
    element.addEventListener("change", () => {
        if (element === filterElements.districtFilter) setRegionOptions();
        updateView();
        if (element === filterElements.districtFilter || element === filterElements.regionFilter) {
            zoomToAreaFilters();
        }
    });
}
document.getElementById("resetFilters").addEventListener("click", () => {
    filterElements.dateFrom.value = filterElements.dateFrom.min;
    filterElements.dateTo.value = filterElements.dateTo.max;
    for (const id of filterIds.slice(2)) filterElements[id].value = "";
    setRegionOptions();
    updateView();
    zoomToAreaFilters();
});
window.addEventListener("resize", () => map.invalidateSize());
loadData().catch(error => {
    document.getElementById("loadError").classList.add("visible");
    document.getElementById("errorDetail").textContent = `${error.message} Die Seite muss über einen Webserver geöffnet werden.`;
    console.error("Fehler beim Laden der Fahrraddiebstahl-Daten:", error);
});

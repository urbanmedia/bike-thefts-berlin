#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

const WFS_URL = "https://gdi.berlin.de/services/wfs/lor_2021";
const FEATURE_TYPE = "lor_2021:a_lor_plr_2021";
const OUTPUT_FIELDS = [
    ["PLR_NAME", "plr_name"],
    ["BZR_ID", "bzr_id"],
    ["BZR_NAME", "bzr_name"],
    ["PGR_ID", "pgr_id"],
    ["PGR_NAME", "pgr_name"],
    ["BEZIRK", "bez"]
];

function usage() {
    return `Usage: node scripts/enrich-lor.mjs <input.csv> [options]

Join the CSV's LOR planning-area codes with Berlin's LOR 2021 WFS data.

Options:
  --output <file>       Enriched CSV (default: <input>-enriched.csv)
  --areas <file>        Also write matched planning-area polygons as GeoJSON
  --id-column <column>  CSV column containing the planning-area ID (default: LOR)
  --help                Show this help

Example:
  node scripts/enrich-lor.mjs Fahrraddiebstahl.csv \\
    --output Fahrraddiebstahl-enriched.csv \\
    --areas lor-areas.geojson`;
}

function parseArguments(argv) {
    const options = { idColumn: "LOR" };
    const positional = [];

    for (let i = 0; i < argv.length; i++) {
        const argument = argv[i];
        if (argument === "--help" || argument === "-h") {
            options.help = true;
        } else if (argument === "--output" || argument === "--areas" || argument === "--id-column") {
            const value = argv[++i];
            if (!value || value.startsWith("--")) {
                throw new Error(`Missing value for ${argument}`);
            }
            if (argument === "--output") options.output = value;
            if (argument === "--areas") options.areas = value;
            if (argument === "--id-column") options.idColumn = value;
        } else if (argument.startsWith("-")) {
            throw new Error(`Unknown option: ${argument}`);
        } else {
            positional.push(argument);
        }
    }

    if (positional.length > 1) {
        throw new Error("Provide one input CSV; use --output to choose the output file.");
    }
    options.input = positional[0];
    return options;
}

function decodeCsv(buffer) {
    const hasUtf8Bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
    const encoding = hasUtf8Bom ? "utf-8" : "windows-1252";
    return new TextDecoder(encoding).decode(buffer).replace(/^\uFEFF/, "");
}

function parseCsv(text) {
    const records = [];
    let record = [];
    let value = "";
    let quoted = false;

    for (let i = 0; i < text.length; i++) {
        const character = text[i];
        if (quoted) {
            if (character === '"' && text[i + 1] === '"') {
                value += '"';
                i++;
            } else if (character === '"') {
                quoted = false;
            } else {
                value += character;
            }
        } else if (character === '"') {
            quoted = true;
        } else if (character === ",") {
            record.push(value);
            value = "";
        } else if (character === "\r" || character === "\n") {
            if (character === "\r" && text[i + 1] === "\n") i++;
            record.push(value);
            if (record.some(field => field !== "")) records.push(record);
            record = [];
            value = "";
        } else {
            value += character;
        }
    }

    if (quoted) throw new Error("The input CSV has an unterminated quoted field.");
    if (value || record.length) {
        record.push(value);
        if (record.some(field => field !== "")) records.push(record);
    }
    if (!records.length) throw new Error("The input CSV is empty.");

    const headers = records.shift().map(header => header.trim());
    if (headers.some(header => !header)) throw new Error("The input CSV has an empty column name.");
    if (new Set(headers).size !== headers.length) throw new Error("The input CSV has duplicate column names.");
    for (let i = 0; i < records.length; i++) {
        if (records[i].length !== headers.length) {
            throw new Error(`CSV row ${i + 2} has ${records[i].length} fields; expected ${headers.length}.`);
        }
    }
    return { headers, records };
}

function quoteCsvField(value) {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function fetchPlanningAreas() {
    const url = new URL(WFS_URL);
    url.search = new URLSearchParams({
        service: "WFS",
        version: "2.0.0",
        request: "GetFeature",
        typeNames: FEATURE_TYPE,
        outputFormat: "application/json",
        srsName: "EPSG:4326"
    });

    const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(60_000)
    });
    if (!response.ok) throw new Error(`LOR WFS request failed with HTTP ${response.status}.`);

    let collection;
    try {
        collection = await response.json();
    } catch (error) {
        throw new Error("The LOR WFS response was not valid JSON.", { cause: error });
    }
    if (collection.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
        throw new Error("The LOR WFS response did not contain a GeoJSON FeatureCollection.");
    }

    const areas = new Map();
    for (const feature of collection.features) {
        const properties = feature.properties;
        const id = properties?.plr_id;
        if (id == null || !feature.geometry) {
            throw new Error("A LOR WFS feature is missing its planning-area ID or geometry.");
        }
        const key = String(id);
        if (areas.has(key)) throw new Error(`The LOR WFS response contains duplicate planning-area ID ${key}.`);
        areas.set(key, feature);
    }
    return areas;
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
        console.log(usage());
        return;
    }
    if (!options.input) throw new Error(usage());

    const inputPath = resolve(options.input);
    const defaultName = `${basename(inputPath, extname(inputPath))}-enriched.csv`;
    const outputPath = resolve(options.output || join(dirname(inputPath), defaultName));
    const areasPath = options.areas ? resolve(options.areas) : null;
    if (inputPath === outputPath || inputPath === areasPath || outputPath === areasPath) {
        throw new Error("Input, enriched CSV, and GeoJSON output paths must be different.");
    }

    const inputText = decodeCsv(await readFile(inputPath));
    const { headers, records } = parseCsv(inputText);
    const idIndex = headers.indexOf(options.idColumn);
    if (idIndex === -1) throw new Error(`The input CSV has no "${options.idColumn}" column.`);

    console.log("Fetching LOR 2021 planning areas from the Berlin WFS…");
    const areas = await fetchPlanningAreas();

    const unmatched = new Set();
    const usedIds = new Set();
    for (const record of records) {
        const id = record[idIndex].trim();
        if (!id || !areas.has(id)) unmatched.add(id || "(empty)");
        else usedIds.add(id);
    }
    if (unmatched.size) {
        const examples = [...unmatched].slice(0, 10).join(", ");
        const suffix = unmatched.size > 10 ? ", …" : "";
        throw new Error(`${unmatched.size} LOR value(s) did not match a planning area: ${examples}${suffix}`);
    }

    const outputHeaders = [...headers];
    for (const [header] of OUTPUT_FIELDS) {
        if (!outputHeaders.includes(header)) outputHeaders.push(header);
    }
    const outputIndexes = new Map(outputHeaders.map((header, index) => [header, index]));
    const outputRows = records.map(record => {
        const row = [...record, ...Array(outputHeaders.length - record.length).fill("")];
        const properties = areas.get(record[idIndex].trim()).properties;
        for (const [header, property] of OUTPUT_FIELDS) {
            row[outputIndexes.get(header)] = properties[property] ?? "";
        }
        return row;
    });
    const csv = [
        outputHeaders.map(quoteCsvField).join(","),
        ...outputRows.map(row => row.map(quoteCsvField).join(","))
    ].join("\r\n");
    await writeFile(outputPath, `\uFEFF${csv}\r\n`, "utf8");

    console.log(`Enriched ${records.length.toLocaleString("en")} rows across ${usedIds.size} planning areas.`);
    console.log(`CSV written to ${outputPath}`);
    if (areasPath) {
        const geojson = {
            type: "FeatureCollection",
            name: "Berlin LOR 2021 planning areas",
            features: [...usedIds].map(id => areas.get(id))
        };
        await writeFile(areasPath, `${JSON.stringify(geojson)}\n`, "utf8");
        console.log(`GeoJSON written to ${areasPath} (${geojson.features.length} areas, EPSG:4326).`);
    }
}

main().catch(error => {
    console.error(`LOR enrichment failed: ${error.message}`);
    process.exitCode = 1;
});

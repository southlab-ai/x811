#!/usr/bin/env node
/**
 * Validate all JSON Schema blocks in the x811 AEEP RFC.
 * Extracts ```json blocks, validates each against JSON Schema draft-07.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Ajv from "ajv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const rfcPath = join(__dirname, "..", "docs", "RFC-x811-AEEP-negotiation.md");
const content = readFileSync(rfcPath, "utf-8");

// Extract all ```json code blocks
const jsonBlockRegex = /```json\s*([\s\S]*?)```/g;
const schemas = [];
let match;
while ((match = jsonBlockRegex.exec(content)) !== null) {
  schemas.push({ content: match[1].trim(), index: schemas.length + 1 });
}

console.log(`Found ${schemas.length} JSON blocks in RFC.\n`);

const ajv = new Ajv({ strict: false });
let failures = 0;

for (const { content: schemaStr, index } of schemas) {
  let schema;
  try {
    schema = JSON.parse(schemaStr);
  } catch (e) {
    console.error(`[FAIL] Block ${index}: Invalid JSON — ${e.message}`);
    failures++;
    continue;
  }

  // Check if it looks like a JSON Schema (has $schema, or type is a valid JSON Schema type keyword)
  const jsonSchemaTypes = ["object", "array", "string", "number", "integer", "boolean", "null"];
  const hasSchemaIndicator =
    schema.$schema ||
    (schema.type && jsonSchemaTypes.includes(schema.type)) ||
    (schema.properties && typeof schema.properties === "object" && schema.required);
  if (!hasSchemaIndicator) {
    console.log(`[SKIP] Block ${index}: Not a JSON Schema`);
    continue;
  }

  const valid = ajv.validateSchema(schema);
  if (!valid) {
    console.error(`[FAIL] Block ${index} (${schema.$id ?? "unknown"}): ${ajv.errorsText()}`);
    failures++;
  } else {
    console.log(`[PASS] Block ${index} (${schema.$id ?? "no $id"})`);
  }
}

console.log(`\n${schemas.length - failures} passed, ${failures} failed.`);
if (failures > 0) process.exit(1);

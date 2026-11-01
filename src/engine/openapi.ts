import type { RouteInfo } from "./router";
import type { FieldRule, Schema } from "./validation";
import { ErrorCodes } from "./errors";

/**
 * يولّد وصف OpenAPI 3.1 للـ API من المسارات المسجلة نفسها، لا من ملف يُكتب باليد.
 *
 * مصدر كل معلومة:
 *   - الطريقة والمسار ومتغيراته: من الـ Router.
 *   - شكل الجسم والاستعلام: من schema في withInput (القواعد نفسها التي تفحص الطلبات).
 *   - المصادقة والصلاحية: من authenticate و requirePermission (engine/route-meta.ts).
 *   - Idempotency-Key و If-Match: من بطاقة المسار.
 * لهذا لا يمكن أن يختلف التوثيق عن الكود: تغيير schema يغيّر التوثيق تلقائياً.
 * CI يعيد توليد docs/openapi.json ويرفض أي فرق عن الملف المحفوظ (npm run openapi:check).
 *
 * حد معروف: أشكال الردود موصوفة بالكلام في docs/API.md، لا كـ schema هنا (الطلبات فقط).
 */

type JsonSchema = Record<string, unknown>;

/** يحوّل قاعدة حقل إلى JSON Schema. */
function ruleToJsonSchema(rule: FieldRule): JsonSchema {
  let schema: JsonSchema;
  switch (rule.type) {
    case "string":
      schema = { type: "string" };
      if (rule.minLength !== undefined) schema.minLength = rule.minLength;
      if (rule.maxLength !== undefined) schema.maxLength = rule.maxLength;
      if (rule.pattern) schema.pattern = rule.pattern.source;
      if (rule.oneOf) schema.enum = [...rule.oneOf];
      break;
    case "number":
      schema = { type: rule.integer ? "integer" : "number" };
      if (rule.min !== undefined) schema.minimum = rule.min;
      if (rule.max !== undefined) schema.maximum = rule.max;
      break;
    case "boolean":
      schema = { type: "boolean" };
      break;
    case "object":
      schema = schemaToJsonSchema(rule.properties);
      break;
    case "array":
      schema = { type: "array", items: ruleToJsonSchema(rule.items) };
      if (rule.minItems !== undefined) schema.minItems = rule.minItems;
      if (rule.maxItems !== undefined) schema.maxItems = rule.maxItems;
      break;
  }
  if (rule.nullable) schema.type = [schema.type as string, "null"];
  if (rule.description) schema.description = rule.description;
  return schema;
}

/** يحوّل schema كاملاً إلى JSON Schema لكائن (الحقول غير المعروفة مرفوضة: additionalProperties: false). */
function schemaToJsonSchema(schema: Schema, partial = false): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [name, rule] of Object.entries(schema)) {
    properties[name] = ruleToJsonSchema(rule);
    if (!rule.optional && !partial) required.push(name);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

/** "/orders/:id/status" تصبح "/orders/{id}/status". */
function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/** معرّف فريد للعملية، مثل patchOrdersIdStatus. */
function operationId(method: string, path: string): string {
  const words = path
    .split("/")
    .filter(Boolean)
    .map((seg) => seg.replace(/^:/, "").replace(/[^A-Za-z0-9]+(.)/g, (_m, c: string) => c.toUpperCase()));
  return method.toLowerCase() + words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

export interface OpenApiOptions {
  title: string;
  version: string;
  description?: string;
  /** بادئة مسارات الـ API (مثل "/v1"). مسارات النظام تبقى من الجذر. */
  basePath?: string;
}

/** يبني وثيقة OpenAPI من مسارات الـ API ومسارات النظام. */
export function generateOpenApi(api: RouteInfo[], system: RouteInfo[], options: OpenApiOptions): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  const add = (route: RouteInfo, prefix: string, tagOverride?: string) => {
    const meta = route.meta;
    const fullPath = toOpenApiPath(`${prefix}${route.path}`);
    const input = meta.input ?? {};
    const parameters: JsonSchema[] = [];

    for (const name of route.paramNames) {
      const rule = input.params?.[name];
      parameters.push({ name, in: "path", required: true, schema: rule ? ruleToJsonSchema(rule) : { type: "string" } });
    }
    for (const [name, rule] of Object.entries(input.query ?? {})) {
      parameters.push({
        name,
        in: "query",
        required: !rule.optional,
        schema: rule.type === "array" ? ruleToJsonSchema(rule) : ruleToJsonSchema(rule),
        ...(rule.description ? { description: rule.description } : {}),
      });
    }
    if (meta.idempotent) {
      parameters.push({
        name: "Idempotency-Key",
        in: "header",
        required: false,
        description: "Send the same random key when retrying, to get the original result instead of a duplicate",
        schema: { type: "string", maxLength: 255 },
      });
    }
    if (meta.conditional) {
      parameters.push({
        name: "If-Match",
        in: "header",
        required: false,
        description: "ETag from a previous read; the change is rejected with 412 if someone changed the resource since",
        schema: { type: "string" },
      });
    }

    const security =
      meta.auth === "required"
        ? [{ ownerKey: [] }, { bearer: [] }]
        : meta.auth === "optional"
          ? [{}, { ownerKey: [] }, { bearer: [] }]
          : [];
    const status = String(meta.successStatus ?? 200);
    const operation: Record<string, unknown> = {
      operationId: operationId(route.method, `${prefix}${route.path}`),
      tags: [tagOverride ?? route.path.split("/")[1] ?? "root"],
      ...(meta.summary ? { summary: meta.summary } : {}),
      ...(meta.permission ? { description: `Requires permission \`${meta.permission}\`.` } : {}),
      ...(parameters.length ? { parameters } : {}),
      security,
      responses: {
        [status]: { description: status === "204" ? "No content" : "Success" },
        "4XX": { $ref: "#/components/responses/Error" },
        "5XX": { $ref: "#/components/responses/Error" },
      },
    };
    if (input.body) {
      operation.requestBody = {
        required: !input.partial,
        content: { "application/json": { schema: schemaToJsonSchema(input.body, input.partial) } },
      };
    }
    paths[fullPath] = { ...paths[fullPath], [route.method.toLowerCase()]: operation };
  };

  for (const route of system) add(route, "", "system");
  for (const route of api) add(route, options.basePath ?? "");

  return {
    openapi: "3.1.0",
    info: { title: options.title, version: options.version, ...(options.description ? { description: options.description } : {}) },
    paths,
    components: {
      securitySchemes: {
        ownerKey: { type: "apiKey", in: "header", name: "X-Api-Key", description: "The store owner's API key" },
        bearer: { type: "http", scheme: "bearer", description: "A customer or staff token from /customers/login or /staff/login" },
      },
      responses: {
        Error: {
          description: "Error",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message", "details", "requestId"],
              properties: {
                code: { type: "string", examples: Object.values(ErrorCodes) },
                message: { type: "string" },
                details: {},
                requestId: { type: ["string", "null"] },
              },
            },
          },
        },
      },
    },
  };
}

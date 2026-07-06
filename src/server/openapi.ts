/**
 * OpenAPI 3.1 document for the versioned `/v1` cloud API. This is the SINGLE
 * source of truth the typed SDK is generated from (see scripts/generate-sdk.ts)
 * and is served live at `GET /openapi.json` and `GET /v1/openapi.json`.
 */
import { getPackageVersion } from "../lib/package-version.js";

const configSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    slug: { type: "string" },
    kind: { type: "string" },
    category: { type: "string" },
    agent: { type: "string" },
    target_path: { type: "string", nullable: true },
    outputs: { type: "array", items: { type: "object" } },
    format: { type: "string" },
    content: { type: "string" },
    description: { type: "string", nullable: true },
    tags: { type: "array", items: { type: "string" } },
    is_template: { type: "boolean" },
    version: { type: "number" },
    created_at: { type: "string" },
    updated_at: { type: "string" },
    synced_at: { type: "string", nullable: true },
  },
} as const;

const profileSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    slug: { type: "string" },
    description: { type: "string", nullable: true },
    selectors: { type: "object" },
    variables: { type: "object" },
    created_at: { type: "string" },
    updated_at: { type: "string" },
  },
} as const;

export function buildV1OpenApiDocument(version = getPackageVersion()) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Instructions V1 API",
      version,
      description:
        "Versioned cloud API for @hasna/instructions (A1 pure-remote). Authenticate with an API key via the `x-api-key` header or `Authorization: Bearer <token>`. Reads require `instructions:read`, writes require `instructions:write` (an `instructions:*` key satisfies both).",
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        apiKey: { type: "apiKey", in: "header", name: "x-api-key" },
      },
      schemas: {
        Config: configSchema,
        Profile: profileSchema,
        CreateConfigInput: {
          type: "object",
          required: ["name", "category", "content"],
          properties: {
            name: { type: "string" },
            category: { type: "string" },
            content: { type: "string" },
            kind: { type: "string" },
            agent: { type: "string" },
            target_path: { type: "string" },
            format: { type: "string" },
            description: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            is_template: { type: "boolean" },
          },
        },
        UpdateConfigInput: {
          type: "object",
          properties: {
            name: { type: "string" },
            category: { type: "string" },
            agent: { type: "string" },
            content: { type: "string" },
            description: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            is_template: { type: "boolean" },
          },
        },
        CreateProfileInput: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            selectors: { type: "object" },
            variables: { type: "object" },
          },
        },
      },
    },
    security: [{ apiKey: [] }],
    paths: {
      "/v1/configs": {
        get: {
          operationId: "listConfigs",
          summary: "List configs",
          parameters: [
            { name: "category", in: "query", schema: { type: "string" } },
            { name: "agent", in: "query", schema: { type: "string" } },
            { name: "kind", in: "query", schema: { type: "string" } },
            { name: "search", in: "query", schema: { type: "string" } },
          ],
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      configs: { type: "array", items: { $ref: "#/components/schemas/Config" } },
                      count: { type: "number" },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          operationId: "createConfig",
          summary: "Create a config",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/CreateConfigInput" } } },
          },
          responses: {
            "201": {
              content: {
                "application/json": {
                  schema: { type: "object", properties: { config: { $ref: "#/components/schemas/Config" } } },
                },
              },
            },
          },
        },
      },
      "/v1/configs/{id}": {
        get: {
          operationId: "getConfig",
          summary: "Get a config by id or slug",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: { type: "object", properties: { config: { $ref: "#/components/schemas/Config" } } },
                },
              },
            },
          },
        },
        patch: {
          operationId: "updateConfig",
          summary: "Update a config",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/UpdateConfigInput" } } },
          },
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: { type: "object", properties: { config: { $ref: "#/components/schemas/Config" } } },
                },
              },
            },
          },
        },
        delete: {
          operationId: "deleteConfig",
          summary: "Delete a config",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: { type: "object", properties: { deleted: { type: "boolean" }, id: { type: "string" } } },
                },
              },
            },
          },
        },
      },
      "/v1/configs/{id}/snapshots": {
        get: {
          operationId: "listSnapshots",
          summary: "List a config's version snapshots",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { snapshots: { type: "array", items: { type: "object" } }, count: { type: "number" } } } } } } },
        },
        post: {
          operationId: "createSnapshot",
          summary: "Snapshot a config's current content",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "201": { content: { "application/json": { schema: { type: "object", properties: { snapshot: { type: "object" } } } } } } },
        },
      },
      "/v1/profiles": {
        get: {
          operationId: "listProfiles",
          summary: "List profiles",
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      profiles: { type: "array", items: { $ref: "#/components/schemas/Profile" } },
                      count: { type: "number" },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          operationId: "createProfile",
          summary: "Create a profile",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/CreateProfileInput" } } },
          },
          responses: { "201": { content: { "application/json": { schema: { type: "object", properties: { profile: { $ref: "#/components/schemas/Profile" } } } } } } },
        },
      },
      "/v1/profiles/{id}": {
        get: {
          operationId: "getProfile",
          summary: "Get a profile (with its configs) by id or slug",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { profile: { $ref: "#/components/schemas/Profile" } } } } } } },
        },
        delete: {
          operationId: "deleteProfile",
          summary: "Delete a profile",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { deleted: { type: "boolean" }, id: { type: "string" } } } } } } },
        },
      },
      "/v1/stats": {
        get: {
          operationId: "getStats",
          summary: "Aggregate config counts by category",
          responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { total: { type: "number" } } } } } } },
        },
      },
    },
  };
}

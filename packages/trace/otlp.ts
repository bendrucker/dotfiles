import type { Tree } from "#trace/tree";

type Value = { stringValue: string } | { intValue: string } | { boolValue: boolean } | { doubleValue: number };

interface Attribute {
  key: string;
  value: Value;
}

function attribute(key: string, value: string | number | boolean): Attribute {
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number") {
    return { key, value: Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value } };
  }
  return { key, value: { stringValue: value } };
}

function nanos(us: number): string {
  return String(BigInt(Math.round(us)) * 1000n);
}

const STATUS_UNSET = 0;
const STATUS_ERROR = 2;
const KIND_INTERNAL = 1;

/** The OTLP/JSON export: what Jaeger's "Upload JSON" and otel-desktop-viewer read. */
export function toOtlp(tree: Tree, resource: Record<string, string>) {
  const spans = tree.nodes.map(({ span, id, parent }) => {
    const attributes: Attribute[] = [attribute("trace.source", span.source)];
    if (span.pid !== undefined) attributes.push(attribute("process.pid", span.pid));
    if (span.status !== undefined) attributes.push(attribute("process.exit_code", span.status));
    for (const [key, value] of Object.entries(span.attributes ?? {})) attributes.push(attribute(key, value));
    return {
      traceId: tree.traceId,
      spanId: id,
      ...(parent ? { parentSpanId: parent.id } : {}),
      name: span.name,
      kind: KIND_INTERNAL,
      startTimeUnixNano: nanos(span.start),
      endTimeUnixNano: nanos(span.end),
      attributes,
      status: span.error
        ? { code: STATUS_ERROR, message: `exited ${span.status ?? "without closing"}` }
        : { code: STATUS_UNSET },
    };
  });
  return {
    resourceSpans: [
      {
        resource: { attributes: Object.entries(resource).map(([key, value]) => attribute(key, value)) },
        scopeSpans: [{ scope: { name: "dotfiles-trace" }, spans }],
      },
    ],
  };
}

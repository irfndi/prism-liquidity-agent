import { createHash } from "crypto";

// Fallback is default: @xenova/transformers crashes in Node when
// serializing BigInt. Set EMBEDDINGS_BACKEND=onnx to opt back into ONNX.
const VECTOR_DIM = 384;

let onnxPromise: Promise<(text: string) => Promise<number[]>> | null = null;

async function loadOnnx(): Promise<(text: string) => Promise<number[]>> {
  if (!onnxPromise) {
    onnxPromise = (async () => {
      const mod = await import("@xenova/transformers");
      const extractor = await mod.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
      return async (text: string) => {
        const output = await extractor(text, {
          pooling: "mean",
          normalize: true,
        });
        return Array.from(output.data as Float32Array);
      };
    })();
    onnxPromise.catch(() => {
      onnxPromise = null;
    });
  }
  return onnxPromise;
}

function fallbackEmbedding(text: string): number[] {
  const vec = Array.from<number>({ length: VECTOR_DIM }).fill(0);
  // Hash consecutive 8-byte windows of the UTF-8 encoding into vector slots.
  // This is not a real semantic embedding but is deterministic and stable
  // for the same input, which is enough to keep the agent from crashing.
  const bytes = Buffer.from(text, "utf-8");
  const window = 8;
  for (let i = 0; i <= bytes.length; i++) {
    const slice = bytes.subarray(i, Math.min(i + window, bytes.length));
    const slot = createHash("sha1").update(slice).digest().readUInt32BE(0) % VECTOR_DIM;
    vec[slot] = (vec[slot] ?? 0) + 1;
  }
  // L2-normalize so callers that expect a unit vector keep working.
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] = (vec[i] ?? 0) / norm;
  return vec;
}

export async function getEmbedding(text: string): Promise<number[]> {
  if (process.env.EMBEDDINGS_BACKEND === "fallback") {
    return fallbackEmbedding(text);
  }
  try {
    const embed = await loadOnnx();
    return await embed(text);
  } catch (err) {
    console.warn(
      "ONNX embedding model unavailable; falling back to deterministic hash vectors. " +
        "Memory similarity will be reduced. Set EMBEDDINGS_BACKEND=fallback to silence this.",
      err instanceof Error ? err.message : String(err),
    );
    return fallbackEmbedding(text);
  }
}

export const EMBEDDING_DIM = VECTOR_DIM;

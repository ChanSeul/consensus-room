import { z } from "zod";

// 문자 수 상한 — JSON Schema 의 maxLength 와 같은 단위(유니코드 코드 포인트)로 센다. zod 의 .max 는 UTF-16 길이를 세어, 서로게이트 쌍(이모지 등)이
// 경계에 걸리면 CLI 출력 스키마(Claude CLI 의 ajv·Codex 구조화 출력)가 받은 값을 서버만 거부했다(R4 리뷰 F001: ASCII 499자 + 😀 는 CLI 500, 서버 501).
// .meta 의 maxLength 가 z.toJSONSchema 로 만드는 스키마(계획 제어 단계)에도 같은 값을 싣는다. CLI 출력 스키마에 한도가 실리는 문자열에만 쓴다.
export function maxCharacters<T extends z.ZodString>(schema: T, limit: number): T {
  return schema.refine(text => [...text].length <= limit, { message: `${limit}자 이하여야 합니다.` }).meta({ maxLength: limit });
}

// maxCharacters 로 정한 상한 — 손으로 쓰는 CLI 출력 스키마가 같은 값을 읽는다.
export function characterLimit(schema: z.ZodType): number {
  const limit = schema.meta()?.maxLength;
  if (typeof limit !== "number") throw new Error("maxCharacters 로 정한 문자 수 상한이 없습니다.");
  return limit;
}

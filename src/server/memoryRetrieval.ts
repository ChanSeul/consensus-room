import { basename } from "node:path";
import type { Topic } from "../shared/contracts.js";
import { workEntry } from "../shared/topicStructure.js";
import type { ConsensusDatabase } from "./database.js";

const SUBJECTS = [
  ["매물등록", "houseregist", "houseregister", "house-register"],
  ["숏폼", "shortform", "short-form"],
  ["consensusroom", "consensus-room", "컨센서스룸"],
  ["매물상세", "housedetail", "house-detail"],
  ["로그인", "login", "auth"],
  ["채팅", "chat"], ["지도", "mainmap"], ["알림", "notification", "push"],
  ["문의", "inquiry"], ["아파트", "apartment"], ["동시성", "concurrency"],
  ["빌드", "build"], ["배포", "release", "deploy", "ci-cd"],
] as const;
const STOP = new Set(["그리고", "합니다", "주세요", "사용자", "계획", "구현", "검토", "코드", "작업", "확인", "확인해줘", "확인하세요", "처리", "구조", "구조를", "어떻게", "관련", "필요한", "동작", "찾아줘"]);
const WEAK = new Set(["승인", "취소", "재시작", "복구", "세션", "재개", "해시", "오류", "리뷰", "실행"]);
const compact = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\s_-]+/g, "");

// Search input chosen by the engine from the topic (advisor 7), never inferred from prompt markers. a3d658b removed the
// builders that emitted the old markers, after which every prompt (role guide, paths, relayed records) became the query.
// subject: the topic's own and ancestors' titles and goals. request: the user's messages in this scope generation.
export interface MemorySearchInput { subject: string; request?: string | null }
export interface MemorySearch { text: string; subjects: readonly string[] }

const subjectsIn = (text: string): string[] => {
  const value = compact(text);
  return SUBJECTS.filter(aliases => aliases.some(alias => value.includes(compact(alias)))).map(aliases => aliases[0]);
};

// Names that make a subject a known feature, so the request may be dropped (advisor 25, engine-review F005). Only explicit
// feature and module names count. SUBJECTS still scores technical notes (빌드·배포·동시성) and short English aliases, but a
// title such as "빌드 오류 수정" names no feature, and short aliases match inside other words (author → auth, ChatGPT → chat).
const FEATURE_NAMES = [
  "매물등록", "houseregist", "houseregister", "house-register", "숏폼", "shortform", "short-form",
  "consensusroom", "consensus-room", "컨센서스룸", "매물상세", "housedetail", "house-detail",
  "로그인", "채팅", "지도", "mainmap", "알림", "문의", "아파트",
].map(compact);
const namesFeature = (text: string) => FEATURE_NAMES.some(name => compact(text).includes(name));

// A subject naming a known feature is the whole query. A generic one is completed by the user's request; the request can be
// a long relayed design, so mixing it in unconditionally lets incidental mentions steer the search again.
// A plain string (callers outside the engine) is treated as the subject.
export function memorySearch(input: string | MemorySearchInput): MemorySearch {
  const { subject, request } = typeof input === "string" ? { subject: input, request: null } : input;
  const text = namesFeature(subject) || !request ? subject : `${subject}\n${request}`;
  return { text, subjects: subjectsIn(text) };
}

// The topic's and its ancestors' titles and goals, and the user's messages in this scope generation (turnExecutor fills
// SessionTurn.memorySearch with it). Execution paths, role guides and relayed records are not search terms.
export function topicMemorySearch(database: Pick<ConsensusDatabase, "getTopic" | "getScopedTimeline">, topic: Topic): MemorySearchInput {
  const chain: Topic[] = [];
  for (let item: Topic | null = topic; item && !chain.some(seen => seen.id === item!.id);
    item = item.parentTopicId ? database.getTopic(item.parentTopicId) : null) chain.push(item);
  const subject = [...new Set(chain.flatMap(item => [item.title, workEntry(item).goal ?? ""]).filter(Boolean))].join("\n");
  const requests = database.getScopedTimeline(topic.id, topic.scopeGeneration).filter(event => event.actor === "user").map(event => event.body);
  return { subject, request: requests.join("\n\n") || null };
}

function tokens(value: string): string[] {
  return [...new Set((value.normalize("NFKC").toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}|[가-힣]{2,}/g) ?? [])
    .filter(token => !STOP.has(token)))];
}

export interface MemoryRelevance { score: number; reason: "subject" | "terms" | "weak-match"; matches: string[]; subjects: string[] }

export function memoryRelevance(search: MemorySearch, path: string, context: string, content: string): MemoryRelevance {
  const query = search.text;
  const file = basename(path, ".md").toLowerCase();
  const headings = content.split(/\r?\n/).filter(line => /^#{1,6} /.test(line)).join("\n").toLowerCase();
  const label = context.toLowerCase();
  const searchable = `${file}\n${label}\n${headings}`;
  // Subject points need the document's identity (file name or link label) to be that feature. Incidental heading mentions,
  // such as login and notification sections of an SDK boundary note, count only as terms below.
  const identity = compact(`${file}\n${label}`);
  const subjects = SUBJECTS.filter(aliases => search.subjects.includes(aliases[0]) && aliases.some(alias => identity.includes(compact(alias))))
    .map(aliases => aliases[0]);
  const queryTokens = tokens(query);
  const matches = queryTokens.filter(token => searchable.includes(token));
  const strong = matches.filter(token => !WEAK.has(token));
  const roleReview = /^(claude|codex)-only\//.test(path) && matches.includes("리뷰");
  const exactFileTerm = matches.some(token => /^[a-z0-9][a-z0-9_-]{2,}$/.test(token)
    && (file === token || file.split(/[_-]/).includes(token)));
  // A lone incidental heading word must not route an otherwise unrelated multi-term request.
  const covered = matches.length / Math.max(queryTokens.length, 1) >= 0.5;
  const eligible = subjects.length > 0 || exactFileTerm || roleReview
    || (covered && (strong.length > 0 || matches.length >= 2));
  if (!eligible) return { score: 0, reason: "weak-match", matches, subjects };
  const lexical = matches.reduce((sum, token) => sum + (file.includes(token) ? 8 : label.includes(token) ? 4 : 2), 0);
  return { score: subjects.length * 40 + lexical, reason: subjects.length ? "subject" : "terms", matches, subjects };
}

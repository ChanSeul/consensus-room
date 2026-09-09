import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Consensus Room을 표시할 root 요소가 없습니다.");
}

void bootstrap(root);

async function bootstrap(container: HTMLElement): Promise<void> {
  const url = new URL(window.location.href);
  const launchToken = url.searchParams.get("token");
  const healthURL = new URL("/api/health", window.location.origin);
  if (launchToken) healthURL.searchParams.set("token", launchToken);

  try {
    const response = await fetch(healthURL, { credentials: "same-origin" });
    if (!response.ok) throw new Error("이 실행에 맞는 접속 토큰이 없습니다.");
    if (launchToken) {
      url.searchParams.delete("token");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
    createRoot(container).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "서버에 연결하지 못했습니다.";
    container.innerHTML = `<main style="min-height:100vh;display:grid;place-items:center;background:#0a0c11;color:#f4f6fb;font-family:-apple-system,sans-serif"><section style="max-width:440px;padding:28px;border:1px solid #3c465a;border-radius:16px;background:#11141b"><h1 style="font-size:20px">Consensus Room에 연결하지 못했습니다.</h1><p style="color:#939cad;line-height:1.6">${escapeHTML(message)} 터미널에 새로 표시된 접속 주소를 열어 주세요.</p></section></main>`;
  }
}

function escapeHTML(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] ?? character);
}

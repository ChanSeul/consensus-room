// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BudgetPanel } from "../src/web/BudgetPanel";
afterEach(cleanup);
it("명시한 예산과 현재 버전을 보내고 실행 중에는 증액하지 못한다",()=>{
 const submit=vi.fn();const account={id:"t",policy:{execution:{inputTokens:100,outputTokens:20,durationMs:60000},total:{inputTokens:1000,outputTokens:200,durationMs:600000}},used:{inputTokens:100,outputTokens:10,durationMs:1000},version:1,source:"test",startedAt:0,pause:{reason:"inputTokens",detectedAt:0,deadline:60000}};
 const view=render(<BudgetPanel account={account} busy={false} onSubmit={submit}/>);
 fireEvent.click(screen.getByRole("button",{name:"예산 추가 후 재개"}));
 fireEvent.change(view.container.querySelector('[name="execution.inputTokens"]')!,{target:{value:"200"}});
 fireEvent.submit(view.container.querySelector("form")!);
 expect(submit).toHaveBeenCalledWith("budget-resume",{policy:{...account.policy,execution:{...account.policy.execution,inputTokens:200}},version:1});
 view.rerender(<BudgetPanel account={account} busy={true} onSubmit={submit}/>);
 expect(screen.getByRole("button",{name:"예산 추가 후 재개"})).toBeDisabled();
});

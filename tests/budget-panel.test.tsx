// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BudgetPanel } from "../src/web/BudgetPanel";
afterEach(cleanup);
it("offers observed interruption recovery only for an idle unfinished execution and keeps its current version",()=>{
 const submit=vi.fn();const account={id:"t",policy:{mode:"observe" as const},used:{inputTokens:123,outputTokens:7,durationMs:9000},version:3,source:"usage-only",startedAt:0,pause:null};
 const view=render(<BudgetPanel account={account} recoveryRequired={true} busy={true} onSubmit={submit}/>);
 expect(screen.getByRole("button",{name:"실행 종료 확인 후 한도 없이 재개"})).toBeDisabled();
 view.rerender(<BudgetPanel account={account} recoveryRequired={true} busy={false} onSubmit={submit}/>);
 expect(screen.getByText(/123/)).toBeVisible();
 fireEvent.click(screen.getByRole("button",{name:"실행 종료 확인 후 한도 없이 재개"}));
 expect(submit).toHaveBeenCalledWith("budget-resume",{policy:{mode:"observe"},version:3});
 view.rerender(<BudgetPanel account={account} recoveryRequired={false} busy={false} onSubmit={submit}/>);
 expect(screen.queryByRole("button",{name:"실행 종료 확인 후 한도 없이 재개"})).toBeNull();
});
it("shows unbounded accounting without demanding a budget or losing the recorded usage",()=>{
 const submit=vi.fn();const account={id:"t",policy:{mode:"observe" as const},used:{inputTokens:12000000,outputTokens:1000,durationMs:3600000},version:2,source:"usage-only",startedAt:0,pause:null};
 const view=render(<BudgetPanel account={null} busy={false} onSubmit={submit}/>);
 expect(screen.getByText("한도 없이 사용량 기록")).toBeVisible();
 expect(screen.queryByText("실행 전에 예산을 설정하세요")).toBeNull();
 view.rerender(<BudgetPanel account={account} busy={false} onSubmit={submit}/>);
 expect(screen.getByText(/12,000,000/)).toBeVisible();
 expect(screen.queryByRole("button",{name:"현재 예산으로 재개"})).toBeNull();
 expect(submit).not.toHaveBeenCalled();
});
it("removes a ceiling only through the explicit versioned policy action",()=>{
 const submit=vi.fn();const account={id:"t",policy:{execution:{inputTokens:100,outputTokens:20,durationMs:60000},total:{inputTokens:1000,outputTokens:200,durationMs:600000}},used:{inputTokens:120,outputTokens:10,durationMs:1000},version:4,source:"test",startedAt:0,pause:null};
 const view=render(<BudgetPanel account={account} busy={true} onSubmit={submit}/>);
 expect(screen.getByRole("button",{name:"한도 없이 계속하기"})).toBeDisabled();
 view.rerender(<BudgetPanel account={account} busy={false} onSubmit={submit}/>);
 fireEvent.click(screen.getByRole("button",{name:"한도 없이 계속하기"}));
 expect(submit).toHaveBeenCalledWith("budget-resume",{policy:{mode:"observe"},version:4});
});
it("offers explicit resumption of the stopped execution only while total allowance remains",()=>{
 const submit=vi.fn();const account={id:"t",policy:{execution:{inputTokens:100,outputTokens:20,durationMs:60000},total:{inputTokens:1000,outputTokens:200,durationMs:600000}},used:{inputTokens:120,outputTokens:10,durationMs:1000},version:4,source:"test",startedAt:0,pause:{executionId:"stopped",reason:"inputTokens",detectedAt:0,deadline:60000}};
 const view=render(<BudgetPanel account={account} busy={false} onSubmit={submit}/>);
 fireEvent.click(screen.getByRole("button",{name:"현재 예산으로 재개"}));
 expect(submit).toHaveBeenCalledWith("budget-resume",{resumeExecutionId:"stopped",version:4});
 view.rerender(<BudgetPanel account={account} busy={true} onSubmit={submit}/>);
 expect(screen.getByRole("button",{name:"현재 예산으로 재개"})).toBeDisabled();
 view.rerender(<BudgetPanel account={{...account,used:{...account.used,inputTokens:1000}}} busy={false} onSubmit={submit}/>);
 expect(screen.queryByRole("button",{name:"현재 예산으로 재개"})).toBeNull();
});
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

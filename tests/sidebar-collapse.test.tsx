// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({
  agentRequest: vi.fn(), codexRequest: vi.fn(), codexRespond: vi.fn(),
}));

import { Sidebar, SidebarRail } from "../src/components/Sidebar";
import { defaultSettings, persistedWorkspace, useAppStore } from "../src/store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;

function render(element: React.ReactElement) {
  const container = document.createElement("div");
  root = createRoot(container);
  act(() => root!.render(element));
  return container;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  useAppStore.setState({ approvals: {}, userInputRequests: {}, settings: defaultSettings });
});

describe("collapsible Chats view", () => {
  it("hides the view from the sidebar heading", () => {
    const onCollapse = vi.fn();
    const container = render(
      <Sidebar codexVersion="" claudeVersion="" showClaude onNewChat={vi.fn()} onReload={vi.fn()} onCollapse={onCollapse} />,
    );
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Hide chats"]')!.click());
    expect(onCollapse).toHaveBeenCalledOnce();
  });

  it("shows the requests that wait for the user on the collapsed rail", () => {
    useAppStore.setState({
      approvals: { a: [{ requestId: 1, method: "item/commandExecution/requestApproval", params: {} }] },
      userInputRequests: { b: [{ requestId: 2, threadId: "b", questions: [] }] },
    });
    const onExpand = vi.fn();
    const onNewChat = vi.fn();
    const container = render(<SidebarRail onExpand={onExpand} onNewChat={onNewChat} />);
    const expand = container.querySelector<HTMLButtonElement>('[aria-label="Show chats"]')!;

    expect(expand.querySelector(".rail-badge")?.textContent).toBe("2");
    act(() => expand.click());
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="New chat"]')!.click());
    expect(onExpand).toHaveBeenCalledOnce();
    expect(onNewChat).toHaveBeenCalledOnce();
  });

  it("saves the collapsed state with the workspace", () => {
    useAppStore.getState().setSettings({ sidebarCollapsed: true });
    expect(persistedWorkspace().settings.sidebarCollapsed).toBe(true);
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import AdminCard from "./AdminCard";

test("renders the title and toggles with aria-expanded (uncontrolled)", () => {
  render(<AdminCard title="Example card">body text</AdminCard>);
  expect(screen.getByRole("heading", { name: "Example card" })).toBeTruthy();
  const button = screen.getByRole("button", { name: "Expand Example card" });
  expect(button.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(button);
  const open = screen.getByRole("button", { name: "Collapse Example card" });
  expect(open.getAttribute("aria-expanded")).toBe("true");
});

test("defaultOpen starts expanded and the action is rendered", () => {
  render(<AdminCard title="Open card" defaultOpen action={<button>Act</button>}>x</AdminCard>);
  expect(screen.getByRole("button", { name: "Collapse Open card" }).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("Act")).toBeTruthy();
});

test("controlled mode follows `open` and reports toggles", () => {
  const onToggle = jest.fn();
  const { rerender } = render(<AdminCard title="Ctl" open={false} onToggle={onToggle}>x</AdminCard>);
  fireEvent.click(screen.getByRole("button", { name: "Expand Ctl" }));
  expect(onToggle).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Expand Ctl" }).getAttribute("aria-expanded")).toBe("false");
  rerender(<AdminCard title="Ctl" open onToggle={onToggle}>x</AdminCard>);
  expect(screen.getByRole("button", { name: "Collapse Ctl" }).getAttribute("aria-expanded")).toBe("true");
});

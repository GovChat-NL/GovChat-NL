import { h } from "../dom.js";

// macOS toggle: form "switch" (on/off slider) or "check" (checkmark box).
export function toggle({ checked, onChange, label, form = "switch" }) {
  const input = h("input", {
    type: "checkbox",
    class: form === "check" ? "check-input" : "switch-input",
    checked,
    role: form === "switch" ? "switch" : undefined,
    onChange: (e) => onChange?.(e.target.checked),
  });
  return h(
    "label",
    { class: `toggle toggle-${form}` },
    input,
    h("span", { class: form === "check" ? "check-box" : "switch-track", "aria-hidden": "true" }),
    label ? h("span", { class: "toggle-label" }, label) : null,
  );
}

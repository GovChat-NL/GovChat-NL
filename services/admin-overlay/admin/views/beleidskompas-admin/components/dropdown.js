import { h, icon } from "../dom.js";

// macOS pop-up button. options: [{ value, label }] or [{ group, options: [...] }].
export function dropdown({ value, options, onChange, label, disabled = false }) {
  const toOption = (o) => h("option", { value: o.value, selected: String(o.value) === String(value) ? true : undefined }, o.label);
  const select = h(
    "select",
    { class: "dropdown-select", disabled, "aria-label": label, onChange: (e) => onChange?.(e.target.value) },
    options.map((o) => (o.group ? h("optgroup", { label: o.group }, o.options.map(toOption)) : toOption(o))),
  );
  return h(
    "label",
    { class: "dropdown" },
    label ? h("span", { class: "dropdown-label" }, label) : null,
    h("span", { class: "dropdown-button" }, select, icon("chevronDown", 12)),
  );
}

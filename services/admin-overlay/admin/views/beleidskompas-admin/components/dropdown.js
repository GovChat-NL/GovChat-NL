import { h, icon } from "../dom.js";

// macOS pop-up button. options: [{ value, label }].
export function dropdown({ value, options, onChange, label, disabled = false }) {
  const toOption = (o) => h("option", { value: o.value, selected: String(o.value) === String(value) ? true : undefined }, o.label);
  const select = h(
    "select",
    { class: "dropdown-select", disabled, "aria-label": label, onChange: (e) => onChange?.(e.target.value) },
    options.map(toOption),
  );
  return h(
    "label",
    { class: "dropdown" },
    label ? h("span", { class: "dropdown-label" }, label) : null,
    h("span", { class: "dropdown-button" }, select, icon("chevronDown", 12)),
  );
}

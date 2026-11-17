// LibreChat keeps the chosen theme in localStorage under "color-theme"
// ("dark", "light" or "system") and marks the page with the class "dark";
// the stylesheet looks for that class. The pages next to LibreChat do the
// same, so they follow the theme the user picked in the chat.
export function applyLibreChatTheme() {
  let theme = null;
  try {
    theme = localStorage.getItem("color-theme");
  } catch {
    // localStorage unavailable (private mode etc.): fall back to the system setting.
  }
  const dark = theme === "dark" || (theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

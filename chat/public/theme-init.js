// @ts-check

try {
  const saved = localStorage.getItem("dark");
  if (saved === "1" || (saved === null && matchMedia("(prefers-color-scheme: dark)").matches)) {
    document.documentElement.classList.add("dark");
  }
} catch {
  // Theme persistence is optional.
}

let hideTimer = null;

export function showToast(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;

  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => toast.classList.add("hidden"), 2500);
}

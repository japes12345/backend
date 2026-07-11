const params = new URLSearchParams(window.location.search);
const userId = params.get("user");
const form = document.querySelector("#preferences-form");
const status = document.querySelector("#status");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  status.textContent = "Saving...";
  const formData = new FormData(form);
  const response = await fetch(`/api/users/${userId}/preferences`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: formData.get("phone"), timezone: formData.get("timezone") }),
  });
  if (!response.ok) {
    status.textContent = "Could not save preferences. Please try again.";
    return;
  }
  status.textContent = "Donna is ready. You will receive prep texts 5 minutes before meetings.";
});

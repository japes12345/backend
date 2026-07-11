fetch("/api/config")
  .then((response) => response.json())
  .then((config) => {
    const link = document.querySelector("#google-login");
    if (config.googleAuthUrl && link) link.href = config.googleAuthUrl;
  })
  .catch(() => {});

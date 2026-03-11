document.getElementById("translate").addEventListener("click", async () => {
  const language = document.getElementById("language").value;

  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  chrome.tabs.sendMessage(tab.id, {
    action: "translate",
    targetLang: language,
  });
});

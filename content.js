chrome.runtime.onMessage.addListener(async () => {
  if (request.action === "translate") {
    const elements = document.querySelectorAll("p,span,h1,h2,h3,a");
    elements.forEach(async el => {
      const text = el.innerText;
      if (text.trim().length > 0) {
        const translated = await translateText(text, request.tartgetLang);
        el.innerText = translated;
      }
    });
  }
});
//Lingo.dev
async function translateText(text, targetLang) {
  const response = await fetch("https://api.lingo.dev/translate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: text,
      target: targetLang,
    }),
  });
  const data = await response.json();
  return data.translation;
}

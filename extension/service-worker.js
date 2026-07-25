// Njia service worker (Manifest V3)
// Two jobs only:
//   1. make the toolbar icon open the side panel (the MV3 user-gesture rule)
//   2. relay per-tab page context from content.js to the side panel
//
// The worker sleeps after ~30s idle, so NOTHING is kept in variables here.
// Page context lives in chrome.storage.session (cleared when the browser
// closes — it is page-derived data and must not outlive the session).

// Clicking the toolbar icon opens the panel. This is the only supported way
// to open it without tripping the user-gesture requirement.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error("Njia: setPanelBehavior failed", e));

// content.js reports { pageId, context } whenever it (re)reads the page.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "njia:context" || sender.tab?.id == null) return;
  const tabId = sender.tab.id;

  // Badge = "Njia recognises this step" cue on the toolbar icon.
  chrome.action.setBadgeText({ tabId, text: msg.pageId ? "●" : "" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#C1502E" });

  // The panel refreshes by READING storage when nudged — so the write must
  // commit before the nudge, or the panel reads the previous step's context
  // and the new step silently loses its explanation.
  chrome.storage.session
    .set({
      ["ctx:" + tabId]: {
        pageId: msg.pageId,
        context: msg.context,
        step: msg.step || null,
      },
    })
    .then(() => {
      // Rejects harmlessly if no panel is open.
      chrome.runtime
        .sendMessage({ type: "njia:context-updated", tabId })
        .catch(() => {});
    });
});

// A navigation wipes that tab's context immediately — otherwise the panel
// keeps describing a page the user already left. If the new page is ours,
// content.js re-pushes at document_idle. (SPA route changes don't fire this;
// the content script's MutationObserver covers those.) `status` needs no
// extra permission, unlike changeInfo.url.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    chrome.action.setBadgeText({ tabId, text: "" });
    // Same write-before-nudge invariant as the context path above: the panel
    // must never win a race and read the departed page's ctx as current.
    chrome.storage.session.remove("ctx:" + tabId).then(() => {
      chrome.runtime
        .sendMessage({ type: "njia:context-updated", tabId })
        .catch(() => {});
    });
  } else if (changeInfo.status === "complete") {
    // Second nudge once the new document commits: the panel's fallback pull
    // at 'loading' can race the navigation and get answered by the OLD page's
    // still-alive content script. Refreshing now corrects the panel against
    // what the new page actually pushed (or against nothing, if it's not a
    // checkpoint page).
    chrome.runtime
      .sendMessage({ type: "njia:context-updated", tabId })
      .catch(() => {});
  }
});

// Drop per-tab context once its tab closes.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove("ctx:" + tabId);
});

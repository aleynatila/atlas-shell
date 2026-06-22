import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Toaster } from "./components/Toaster";
import "./index.css";
import { showToast } from "./lib/toast";

// Surface uncaught async errors / unhandled promise rejections to the toast bus
// so silent failures aren't lost in the devtools console.
if (typeof window !== "undefined") {
  window.addEventListener("error", (e) => {
    const msg = e.error?.message || e.message || "Unknown error";
    showToast("Uncaught error", { variant: "error", detail: msg });
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    const msg =
      reason instanceof Error
        ? reason.message
        : typeof reason === "string"
          ? reason
          : JSON.stringify(reason);
    showToast("Unhandled promise rejection", {
      variant: "error",
      detail: msg,
    });
  });
}

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
    <Toaster />
  </ErrorBoundary>,
);

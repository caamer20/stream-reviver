import { DISCLAIMER } from "../shared/defaults";
import { apiCall, ext, sendMessage } from "../shared/api";
import type { RuntimeMessage } from "../shared/types";

const agree = document.getElementById("agree") as HTMLInputElement;
const button = document.getElementById("continue") as HTMLButtonElement;
const feedback = document.getElementById("feedback") as HTMLElement;
(document.getElementById("disclaimer") as HTMLElement).textContent = DISCLAIMER;

agree.addEventListener("change", () => { button.disabled = !agree.checked; });
button.addEventListener("click", async () => {
  button.disabled = true;
  try {
    await sendMessage({ type: "ACKNOWLEDGE_DISCLAIMER" } satisfies RuntimeMessage);
    feedback.textContent = "Acknowledged. Opening settings…";
    await apiCall<void>(ext.runtime.openOptionsPage, ext.runtime);
    window.close();
  } catch (error) {
    feedback.textContent = error instanceof Error ? error.message : String(error);
    button.disabled = false;
  }
});

/** Whether the first-run wizard should open (kept apart so the wizard itself loads only when needed). */
export const WIZARD_KEY = 'postino.wizard';
export const markWizardOpen = () => {
  try {
    localStorage.setItem(WIZARD_KEY, '1');
  } catch {
    /* ignore */
  }
};
export const wizardWanted = () => {
  try {
    return localStorage.getItem(WIZARD_KEY) === '1';
  } catch {
    return false;
  }
};

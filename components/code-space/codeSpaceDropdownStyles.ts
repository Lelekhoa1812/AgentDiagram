// Root Cause vs Logic: these dropdowns live inside fixed-width popovers, so the option text column needs to be flexible
// and the description needs to wrap; otherwise longer copy is clipped by the popover's overflow handling.
export const CODE_SPACE_DROPDOWN_OPTION_TEXT_CLASS = 'min-w-0 flex-1';

export const CODE_SPACE_DROPDOWN_OPTION_DESCRIPTION_CLASS =
  'block text-[9px] leading-3 text-[#8b949e] whitespace-normal break-words';

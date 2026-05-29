export type MouseWheelDirection = "up" | "down";

const SGR_MOUSE_PREFIX = "\x1b[<";
const X10_MOUSE_PREFIX = "\x1b[M";
const WHEEL_UP_BUTTON = 64;
const ENABLE_MOUSE_REPORTING = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE_REPORTING = "\x1b[?1006l\x1b[?1000l";

let mouseReportingRetainers = 0;
let mouseReportingEnabled = false;

function getWheelDirection(
  buttonCode: number
): MouseWheelDirection | undefined {
  if (buttonCode < WHEEL_UP_BUTTON) {
    return undefined;
  }

  switch ((buttonCode - WHEEL_UP_BUTTON) % 4) {
    case 0:
      return "up";
    case 1:
      return "down";
    default:
      return undefined;
  }
}

export function getMouseWheelDirection(
  data: string
): MouseWheelDirection | undefined {
  if (
    data.startsWith(SGR_MOUSE_PREFIX) &&
    (data.endsWith("M") || data.endsWith("m"))
  ) {
    const [buttonCode] = data.slice(SGR_MOUSE_PREFIX.length, -1).split(";");
    const parsedButtonCode = Number.parseInt(buttonCode ?? "", 10);
    if (!Number.isNaN(parsedButtonCode)) {
      return getWheelDirection(parsedButtonCode);
    }
  }

  if (data.startsWith(X10_MOUSE_PREFIX) && data.length >= 6) {
    return getWheelDirection(data.charCodeAt(3) - 32);
  }

  return undefined;
}

export function retainMouseWheelReporting(): () => void {
  mouseReportingRetainers++;

  if (!mouseReportingEnabled && process.stdout.isTTY) {
    process.stdout.write(ENABLE_MOUSE_REPORTING);
    mouseReportingEnabled = true;
  }

  let released = false;
  return () => {
    if (released) {
      return;
    }

    released = true;
    mouseReportingRetainers = Math.max(0, mouseReportingRetainers - 1);

    if (
      mouseReportingRetainers === 0 &&
      mouseReportingEnabled &&
      process.stdout.isTTY
    ) {
      process.stdout.write(DISABLE_MOUSE_REPORTING);
      mouseReportingEnabled = false;
    }
  };
}

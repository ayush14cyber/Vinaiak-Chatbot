// One JSON line per event, as CloudWatch keeps them: `{"level", "msg", ...fields}`.

function write(level, fields, msg) {
  const line = JSON.stringify({ level, msg, ...fields }, (_, value) =>
    typeof value === "bigint" ? value.toString() : value instanceof Error ? value.message : value,
  );
  if (level === "ERROR") console.error(line);
  else if (level === "WARN") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (fields, msg) => write("INFO", fields, msg),
  warn: (fields, msg) => write("WARN", fields, msg),
  error: (fields, msg) => write("ERROR", fields, msg),
};

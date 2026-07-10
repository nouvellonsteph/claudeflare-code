import { useState, useEffect } from "react";

export function useIdentity() {
  const [email, setEmail] = useState("--");

  useEffect(() => {
    fetch("/api/whoami")
      .then((r) => r.json())
      .then((d: any) => {
        const user = d.email || "unknown";
        setEmail(user);
        document.title = `Claudeflare Code \u2014 ${user}`;
      })
      .catch(() => setEmail("unknown"));
  }, []);

  return email;
}

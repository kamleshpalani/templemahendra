import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import api from "../services/api";

/**
 * AuthContext — the signed-in devotee, for the public site only.
 *
 * The server holds the session in an httpOnly cookie, so there is no token to
 * keep here: on boot we ask /auth/me who we are and get a CSRF token back.
 * Every state-changing call echoes that token in X-CSRF-Token.
 *
 * `ready` is false until that first answer arrives. Guarded routes wait for it
 * rather than bouncing a signed-in devotee to the login page on a refresh.
 *
 * `accountsEnabled` is false when migration 003 has not been applied, so the
 * site can hide account entry points instead of offering a door that 503s.
 */
const AuthContext = createContext(null);

/** Shape thrown by every call so pages can show field errors consistently. */
export class AuthError extends Error {
  constructor(message, { fields = {}, code = null, status = 0 } = {}) {
    super(message);
    this.name = "AuthError";
    this.fields = fields;
    this.code = code;
    this.status = status;
  }
}

const GENERIC = "Something went wrong. Please try again.";

function toAuthError(err) {
  const res = err?.response;
  const data = res?.data ?? {};
  if (!res) {
    return new AuthError("Could not reach the temple server. Check your connection and try again.", {
      code: "network",
    });
  }
  // Most failures put their text in `error`; the resend endpoint's 503 puts
  // it in `message`. Reading both means a real explanation is never replaced
  // by the generic one.
  return new AuthError(data.error || data.message || GENERIC, {
    fields: data.fields ?? {},
    code: data.code ?? null,
    status: res.status,
  });
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [accountsEnabled, setAccountsEnabled] = useState(true);
  const csrf = useRef("");

  /** Read the session. Also the way a stale CSRF token is refreshed. */
  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get("/auth/me");
      csrf.current = data.csrf ?? "";
      setUser(data.user ?? null);
      setAccountsEnabled(data.accountsEnabled !== false);
      return data.user ?? null;
    } catch {
      // A failure here means the API is unreachable or accounts are off. Either
      // way the visitor is a guest; the rest of the site keeps working.
      setUser(null);
      return null;
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /**
   * POST with the CSRF header. One retry when the server says the token is
   * stale, which happens after a session expires while a tab sat open.
   */
  const post = useCallback(
    async (path, body = {}, { retry = true } = {}) => {
      if (!csrf.current) await refresh();
      try {
        const { data } = await api.post(path, body, { headers: { "X-CSRF-Token": csrf.current } });
        if (data?.csrf) csrf.current = data.csrf;
        return data;
      } catch (err) {
        if (retry && err?.response?.status === 419) {
          await refresh();
          return post(path, body, { retry: false });
        }
        throw toAuthError(err);
      }
    },
    [refresh],
  );

  const get = useCallback(async (path, config) => {
    try {
      const { data } = await api.get(path, config);
      return data;
    } catch (err) {
      throw toAuthError(err);
    }
  }, []);

  const value = useMemo(() => {
    const adopt = (data) => {
      if (data?.user) setUser(data.user);
      return data;
    };
    return {
      user,
      ready,
      accountsEnabled,
      refresh,
      get,

      register: (payload) => post("/auth/register", payload),
      login: (email, password) => post("/auth/login", { email, password }).then(adopt),
      logout: async () => {
        try {
          await post("/auth/logout");
        } finally {
          setUser(null);
          // The session id changed, so the old CSRF token is void. Refresh it
          // without blocking: awaiting here kept the caller on a guarded route
          // for another round trip with `user` already null, which flashed the
          // sign-in page on the way out.
          refresh();
        }
      },
      verify: (token) => post("/auth/verify", { token }).then(adopt),
      resend: () => post("/auth/resend"),
      forgot: (email) => post("/auth/forgot", { email }),
      reset: (token, password) => post("/auth/reset", { token, password }).then(adopt),
      updateProfile: (payload) => post("/account/profile", payload).then(adopt),
      changePassword: (currentPassword, newPassword) =>
        post("/account/password", { currentPassword, newPassword }),
    };
  }, [user, ready, accountsEnabled, refresh, post, get]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

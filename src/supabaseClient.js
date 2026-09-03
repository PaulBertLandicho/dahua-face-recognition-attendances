// src/supabaseClient.js
// Custom MySQL Client Adapter to completely replace Supabase

const API_BASE = "";

class QueryBuilder {
  constructor(table) {
    this.table = table;
    this.action = "select";
    this.selectedColumns = "*";
    this.filters = [];
    this.orders = [];
    this.limitCount = null;
    this.offsetCount = null;
    this.singleRow = false;
    this.maybeSingleRow = false;
    this.payloadData = null;
    this.countOption = null;
    this.returning = false;
  }

  select(columns = "*", options = {}) {
    this.selectedColumns = columns;
    if (["insert", "update", "upsert"].includes(this.action)) {
      this.returning = true;
    } else {
      this.action = "select";
    }
    if (options && options.count) this.countOption = options.count;
    return this;
  }

  insert(data) {
    this.action = "insert";
    this.payloadData = data;
    return this;
  }

  update(data) {
    this.action = "update";
    this.payloadData = data;
    return this;
  }

  upsert(data) {
    this.action = "upsert";
    this.payloadData = data;
    return this;
  }

  delete() {
    this.action = "delete";
    return this;
  }

  eq(column, value) {
    this.filters.push({ column, op: "eq", value });
    return this;
  }

  neq(column, value) {
    this.filters.push({ column, op: "neq", value });
    return this;
  }

  gt(column, value) {
    this.filters.push({ column, op: "gt", value });
    return this;
  }

  gte(column, value) {
    this.filters.push({ column, op: "gte", value });
    return this;
  }

  lt(column, value) {
    this.filters.push({ column, op: "lt", value });
    return this;
  }

  lte(column, value) {
    this.filters.push({ column, op: "lte", value });
    return this;
  }

  like(column, value) {
    this.filters.push({ column, op: "like", value });
    return this;
  }

  ilike(column, value) {
    this.filters.push({ column, op: "ilike", value });
    return this;
  }

  is(column, value) {
    this.filters.push({ column, op: "is", value });
    return this;
  }

  in(column, values) {
    this.filters.push({ column, op: "in", value: values });
    return this;
  }

  order(column, options = {}) {
    this.orders.push({
      column,
      ascending: options.ascending !== false,
      nullsFirst: options.nullsFirst || false,
    });
    return this;
  }

  limit(count) {
    this.limitCount = count;
    return this;
  }

  range(from, to) {
    this.offsetCount = from;
    this.limitCount = to - from + 1;
    return this;
  }

  single() {
    this.singleRow = true;
    return this;
  }

  maybeSingle() {
    this.maybeSingleRow = true;
    return this;
  }

  async execute() {
    try {
      const res = await fetch(`${API_BASE}/api/db/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          table: this.table,
          action: this.action,
          select: this.selectedColumns,
          filters: this.filters,
          orders: this.orders,
          limit: this.limitCount,
          offset: this.offsetCount,
          data: this.payloadData,
          single: this.singleRow,
          maybeSingle: this.maybeSingleRow,
          count: this.countOption,
          returning: this.returning,
        }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
        return { data: null, error: errJson.error || { message: `Request failed with status ${res.status}` } };
      }

      const result = await res.json();
      return result;
    } catch (err) {
      return { data: null, error: { message: err.message || "Network error" } };
    }
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }
}

const authListeners = new Set();

const auth = {
  async signInWithPassword({ email, password }) {
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        return { data: null, error: data.error || { message: "Invalid login credentials." } };
      }
      if (data.data?.session) {
        localStorage.setItem("sb-session", JSON.stringify(data.data.session));
        authListeners.forEach((cb) => {
          try { cb("SIGNED_IN", data.data.session); } catch (e) {}
        });
      }
      return { data: data.data, error: null };
    } catch (err) {
      return { data: null, error: { message: err.message || "Login request failed" } };
    }
  },

  async getSession() {
    try {
      const stored = localStorage.getItem("sb-session");
      const session = stored ? JSON.parse(stored) : null;
      return { data: { session }, error: null };
    } catch (err) {
      return { data: { session: null }, error: null };
    }
  },

  async getUser() {
    const { data: { session } } = await this.getSession();
    return { data: { user: session?.user || null }, error: null };
  },

  async signOut() {
    localStorage.removeItem("sb-session");
    authListeners.forEach((cb) => {
      try { cb("SIGNED_OUT", null); } catch (e) {}
    });
    return { error: null };
  },

  onAuthStateChange(callback) {
    authListeners.add(callback);
    return {
      data: {
        subscription: {
          unsubscribe: () => authListeners.delete(callback),
        },
      },
    };
  },
};

export const SUPABASE_CONFIGURED = true;

const channelMock = {
  on() { return this; },
  subscribe() { return this; },
  unsubscribe() { return Promise.resolve(); },
  off() { return this; },
};

export const supabase = {
  from(table) {
    return new QueryBuilder(table);
  },
  auth,
  channel(name) {
    return channelMock;
  },
  removeChannel(ch) {
    if (ch && typeof ch.unsubscribe === "function") {
      try { ch.unsubscribe(); } catch (e) {}
    }
  },
};

export function subscribeToTable({ table = 'attendance', callback }) {
  return channelMock;
}

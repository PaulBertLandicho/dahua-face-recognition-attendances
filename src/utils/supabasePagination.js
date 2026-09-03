// Cursor pagination helper for Supabase
// Usage: import { fetchAttendancePage } from 'src/utils/supabasePagination'
// The helper fetches pageSize+1 rows to determine hasMore and returns nextCursor

export async function fetchAttendancePage({
  supabase,
  table = 'attendance',
  select = 'id, person_id, name, department, event, point, method, device_time, created_at, status, archived, photo',
  pageSize = 20,
  cursor = null, // fetch records older than this id when ordering desc
  orderBy = { column: 'id', ascending: false },
  filters = [], // array of { column, operator, value }
}) {
  if (!supabase) throw new Error('supabase client required');

  let q = supabase.from(table).select(select).order(orderBy.column, { ascending: orderBy.ascending });

  // apply cursor for cursor-based pagination
  if (cursor) {
    // if ordering desc and cursor is last id, fetch id < cursor
    q = orderBy.ascending ? q.gt(orderBy.column, cursor) : q.lt(orderBy.column, cursor);
  }

  // apply simple filters
  for (const f of filters) {
    const { column, operator = 'eq', value } = f;
    if (column && typeof value !== 'undefined') q = q[operator](column, value);
  }

  q = q.limit(pageSize + 1);

  const { data, error } = await q;
  if (error) throw error;

  const rows = data || [];
  const hasMore = rows.length > pageSize;
  const pageData = hasMore ? rows.slice(0, pageSize) : rows;
  const nextCursor = hasMore ? pageData[pageData.length - 1][orderBy.column] : null;

  return {
    data: pageData,
    nextCursor,
    hasMore,
  };
}

/*
React Query (useInfiniteQuery) example usage (in your component):

import { useInfiniteQuery } from 'react-query';
import { fetchAttendancePage } from 'src/utils/supabasePagination';
import supabase from '../mysqlClient';

function useAttendancesInfinite(pageSize = 20) {
  return useInfiniteQuery(
    ['attendance', pageSize],
    async ({ pageParam = null }) => {
      return fetchAttendancePage({ supabase, pageSize, cursor: pageParam });
    },
    {
      getNextPageParam: (last) => last.nextCursor || undefined,
      staleTime: 1000 * 60 * 2, // 2 minutes
      cacheTime: 1000 * 60 * 10,
    }
  );
}

// In component:
// const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useAttendancesInfinite(20);
// data.pages.flatMap(p => p.data) -> full list so far
*/
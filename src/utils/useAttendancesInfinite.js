// React Query `useInfiniteQuery` hook example for Supabase cursor pagination
import { useInfiniteQuery } from '@tanstack/react-query';
import { supabase } from '../mysqlClient';
import { fetchAttendancePage } from './supabasePagination';

export function useAttendancesInfinite({ pageSize = 30, initialFilters = [] } = {}) {
  return useInfiniteQuery(
    {
      queryKey: ['attendance', pageSize, initialFilters],
      queryFn: async ({ pageParam = null }) => {
        return fetchAttendancePage({
          table: 'attendance',
          supabase,
          pageSize,
          cursor: pageParam,
          filters: initialFilters,
          orderBy: { column: 'device_time', ascending: false },
        });
      },
      getNextPageParam: (last) => last.nextCursor || undefined,
      staleTime: 1000 * 60 * 2,
      cacheTime: 1000 * 60 * 10,
    }
  );
}

/* Usage example in a component:

import { useAttendancesInfinite } from 'src/utils/useAttendancesInfinite';

function MyList() {
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useAttendancesInfinite({ pageSize: 30, initialFilters: [] });
  const items = data ? data.pages.flatMap(p => p.data) : [];
  return (
    <div>
      {items.map(i => <div key={i.id}>{i.person_id} - {i.device_time}</div>)}
      {hasNextPage && <button onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>{isFetchingNextPage ? 'Loading...' : 'Load more'}</button>}
    </div>
  );
}

*/

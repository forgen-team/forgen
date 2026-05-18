---
title: 로직 종류에 따라 합쳐진 함수 쪼개기
source: https://frontend-fundamentals.com/code-quality/code/examples/use-page-state-readability.html
fetched: 2026-05-18
principle: readability
---

# 로직 종류에 따라 합쳐진 함수 쪼개기

쿼리 파라미터, 상태, API 호출과 같은 로직의 종류에 따라서 함수나 컴포넌트, Hook을 만들지 마세요. 한 번에 다루는 맥락의 종류가 많아져서 이해하기 힘들고 수정하기 어려운 코드가 돼요.

## 📝 코드 예시

다음 `usePageState()` Hook은 페이지 전체의 URL 쿼리 파라미터를 한 번에 관리해요.

```typescript
export function usePageState() {
  const [query, setQuery] = useQueryParams({
    cardId: NumberParam,
    statementId: NumberParam,
    dateFrom: DateParam,
    dateTo: DateParam,
    statusList: ArrayParam
  });

  return useMemo(
    () => ({
      values: {
        cardId: query.cardId ?? undefined,
        statementId: query.statementId ?? undefined,
        dateFrom: query.dateFrom == null ? defaultDateFrom : moment(query.dateFrom),
        dateTo: query.dateTo == null ? defaultDateTo : moment(query.dateTo),
        statusList: query.statusList as StatementStatusType[] | undefined
      },
      controls: {
        setCardId: (cardId: number) => setQuery({ cardId }, "replaceIn"),
        setStatementId: (statementId: number) => setQuery({ statementId }, "replaceIn"),
        setDateFrom: (date?: Moment) => setQuery({ dateFrom: date?.toDate() }, "replaceIn"),
        setDateTo: (date?: Moment) => setQuery({ dateTo: date?.toDate() }, "replaceIn"),
        setStatusList: (statusList?: StatementStatusType[]) => setQuery({ statusList }, "replaceIn")
      }
    }),
    [query, setQuery]
  );
}
```

## 👃 코드 냄새 맡아보기

### 가독성

이 Hook이 가지고 있는 책임이 "페이지가 필요로 하는 모든 쿼리 파라미터를 관리하는 것" 임을 고려했을 때, 이 Hook이 담당할 책임이 무제한적으로 늘어날 가능성이 있어요.

점점 Hook이 담당하고 있는 영역이 넓어지면서, 구현이 길어지고, 어떤 역할을 하는 Hook인지 파악하기 힘들어져요.

### 성능

이 Hook을 쓰는 컴포넌트는, 이 Hook이 관리하는 어떤 쿼리 파라미터가 수정되더라도 리렌더링이 발생해요.

## ✏️ 개선해보기

다음 코드와 같이 각각의 쿼리 파라미터별로 별도의 Hook을 작성할 수 있어요.

```typescript
export function useCardIdQueryParam() {
  const [cardId, _setCardId] = useQueryParam("cardId", NumberParam);

  const setCardId = useCallback((cardId: number) => {
    _setCardId({ cardId }, "replaceIn");
  }, []);

  return [cardId ?? undefined, setCardId] as const;
}
```

Hook이 담당하는 책임을 분리했기 때문에, 기존 `usePageState()` Hook보다 명확한 이름을 가져요.
또한 Hook을 수정했을 때 영향이 갈 범위를 좁혀서, 예상하지 못한 변경이 생기는 것을 막을 수 있어요.

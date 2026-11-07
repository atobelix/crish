import {
  clearSheetHeightCache,
  openingPlan,
  readSheetHeight,
  resolveTravelOnMeasure,
  sheetHeightCacheKey,
  travelAfterEnterFinished,
  writeSheetHeight,
} from './sheetHeightCache';

describe('Sheet 实测高度缓存', () => {
  beforeEach(() => {
    clearSheetHeightCache();
  });

  it('缓存键含身份、窗口、档位与内容', () => {
    const base = {
      overlayId: 'model-sheet',
      windowWidth: 390.4,
      windowHeight: 844.2,
      size: 'large',
      contentKey: 'a,b',
    };
    expect(sheetHeightCacheKey(base)).toBe('model-sheet|390x844|large|a,b');
    expect(
      sheetHeightCacheKey({ ...base, windowWidth: 844, windowHeight: 390 })
    ).not.toBe(sheetHeightCacheKey(base));
    expect(sheetHeightCacheKey({ ...base, contentKey: 'a,b,c' })).not.toBe(
      sheetHeightCacheKey(base)
    );
    expect(sheetHeightCacheKey({ ...base, size: 'full' })).not.toBe(
      sheetHeightCacheKey(base)
    );
  });

  it('首次无缓存则等待实测，有缓存或已测则进场', () => {
    expect(openingPlan({ cached: null, alreadyMeasured: 0 })).toEqual({
      travelHeight: 0,
      reveal: false,
    });
    const key = sheetHeightCacheKey({
      overlayId: 'model-sheet',
      windowWidth: 390,
      windowHeight: 844,
      size: 'large',
      contentKey: '',
    });
    writeSheetHeight(key, 240);
    expect(readSheetHeight(key)).toBe(240);
    expect(openingPlan({ cached: readSheetHeight(key), alreadyMeasured: 0 })).toEqual({
      travelHeight: 240,
      reveal: true,
    });
    expect(openingPlan({ cached: 180, alreadyMeasured: 240 })).toEqual({
      travelHeight: 240,
      reveal: true,
    });
  });

  it('进场与退场途中锁定行程，静止时采纳新测量', () => {
    expect(
      resolveTravelOnMeasure({
        phase: 'animating',
        travelHeight: 240,
        latestMeasured: 300,
      })
    ).toEqual({ travelHeight: 240, changed: false });
    expect(
      resolveTravelOnMeasure({
        phase: 'closing',
        travelHeight: 240,
        latestMeasured: 180,
      })
    ).toEqual({ travelHeight: 240, changed: false });
    expect(
      resolveTravelOnMeasure({
        phase: 'settled',
        travelHeight: 240,
        latestMeasured: 300,
      })
    ).toEqual({ travelHeight: 300, changed: true });
    expect(
      resolveTravelOnMeasure({
        phase: 'waiting',
        travelHeight: 0,
        latestMeasured: 240,
      })
    ).toEqual({ travelHeight: 240, changed: true });
  });

  it('完成回调忽略首帧闭包高度，只取最新实测', () => {
    expect(
      travelAfterEnterFinished({
        latestMeasured: 240,
        inFlightTravel: 680,
        staleClosureHeight: 0,
      })
    ).toBe(240);
    expect(
      travelAfterEnterFinished({
        latestMeasured: 0,
        inFlightTravel: 240,
        staleClosureHeight: 680,
      })
    ).toBe(240);
    expect(
      travelAfterEnterFinished({
        latestMeasured: 0,
        inFlightTravel: 0,
        staleClosureHeight: 680,
      })
    ).toBe(0);
  });
});

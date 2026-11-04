// Compiles the vendored QuickJS-NG amalgamation (vendor/quickjs-ng) as one
// translation unit, with assertions off as in upstream release builds.
#ifndef NDEBUG
#define NDEBUG
#endif
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

// The deterministic bridge runs on a dedicated thread. Interpose only this
// engine translation unit's clock/timezone reads; app clocks and ordinary
// run_js executions retain their platform behavior.
#include <stdint.h>
#include <sys/time.h>
#include <time.h>

static _Thread_local int crish_clock_enabled;
static _Thread_local int64_t crish_realtime_us;
static _Thread_local int64_t crish_monotonic_us;

void crish_js_clock(int enabled, int64_t realtime_us, int64_t monotonic_us) {
  crish_clock_enabled = enabled;
  crish_realtime_us = realtime_us;
  crish_monotonic_us = monotonic_us;
}

void cherry_js_clock(int enabled, int64_t realtime_us, int64_t monotonic_us) {
  crish_js_clock(enabled, realtime_us, monotonic_us);
}

static int crish_gettimeofday(struct timeval *value, void *zone) {
  if (!crish_clock_enabled) return gettimeofday(value, zone);
  value->tv_sec = crish_realtime_us / 1000000;
  value->tv_usec = crish_realtime_us % 1000000;
  return 0;
}

static int crish_clock_gettime(clockid_t id, struct timespec *value) {
  if (!crish_clock_enabled) return clock_gettime(id, value);
  const int64_t us = id == CLOCK_REALTIME ? crish_realtime_us : crish_monotonic_us;
  value->tv_sec = us / 1000000;
  value->tv_nsec = (us % 1000000) * 1000;
  return 0;
}

static struct tm *crish_localtime_r(const time_t *value, struct tm *result) {
  return crish_clock_enabled ? gmtime_r(value, result) : localtime_r(value, result);
}

#define gettimeofday crish_gettimeofday
#define clock_gettime crish_clock_gettime
#define localtime_r crish_localtime_r
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Weverything"
#include "quickjs-amalgam.c"
#pragma clang diagnostic pop
#undef gettimeofday
#undef clock_gettime
#undef localtime_r

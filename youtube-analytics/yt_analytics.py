#!/usr/bin/env python3
"""Fetch your channel's YouTube Analytics, print a summary and save CSV files.

Needs YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET and YOUTUBE_REFRESH_TOKEN in the
environment (see README.md for how to get them).

    python3 yt_analytics.py                      # last 28 days, ending yesterday
    python3 yt_analytics.py --days 90
    python3 yt_analytics.py --start 2026-01-01 --end 2026-06-30

Uses only the Python standard library.
"""

import argparse
import csv
import datetime as dt
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

TOKEN_URL = "https://oauth2.googleapis.com/token"
DATA_API = "https://www.googleapis.com/youtube/v3"
REPORTS_URL = "https://youtubeanalytics.googleapis.com/v2/reports"
REVENUE_SCOPE = "https://www.googleapis.com/auth/yt-analytics-monetary.readonly"

CORE_METRICS = ("views,estimatedMinutesWatched,averageViewDuration,"
                "subscribersGained,subscribersLost,likes,comments,shares")

# One YouTube Analytics query per report; each is saved as <name>.csv.
REPORTS = {
    "totals": {"metrics": CORE_METRICS},
    "daily": {"dimensions": "day", "metrics": CORE_METRICS, "sort": "day"},
    "top_videos": {
        "dimensions": "video",
        "metrics": "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,subscribersGained",
        "sort": "-views",
        "maxResults": 200,
    },
    "traffic_sources": {"dimensions": "insightTrafficSourceType", "metrics": "views,estimatedMinutesWatched",
                        "sort": "-views"},
    "countries": {"dimensions": "country", "metrics": "views,estimatedMinutesWatched", "sort": "-views"},
    "devices": {"dimensions": "deviceType", "metrics": "views,estimatedMinutesWatched", "sort": "-views"},
    "demographics": {"dimensions": "ageGroup,gender", "metrics": "viewerPercentage"},
}
# Only fetched when get_refresh_token.py was run with --revenue.
REVENUE_REPORT = {"dimensions": "day", "metrics": "estimatedRevenue,estimatedAdRevenue,estimatedRedPartnerRevenue",
                  "sort": "day"}

# The names YouTube Studio uses for insightTrafficSourceType values.
TRAFFIC_SOURCE_NAMES = {
    "ADVERTISING": "YouTube advertising",
    "ANNOTATION": "Cards and annotations",
    "CAMPAIGN_CARD": "Campaign cards",
    "END_SCREEN": "End screens",
    "EXT_URL": "External",
    "HASHTAGS": "Hashtag pages",
    "LIVE_REDIRECT": "Live redirects",
    "NO_LINK_EMBEDDED": "Embedded players",
    "NO_LINK_OTHER": "Direct or unknown",
    "NOTIFICATION": "Notifications",
    "PLAYLIST": "Playlists",
    "PRODUCT_PAGE": "Product pages",
    "PROMOTED": "YouTube promotions",
    "RELATED_VIDEO": "Suggested videos",
    "SHORTS": "Shorts feed",
    "SOUND_PAGE": "Sound pages",
    "SUBSCRIBER": "Browse features",
    "VIDEO_REMIXES": "Remixes",
    "YT_CHANNEL": "Channel pages",
    "YT_OTHER_PAGE": "Other YouTube features",
    "YT_PLAYLIST_PAGE": "Playlist pages",
    "YT_SEARCH": "YouTube search",
}


class GoogleError(Exception):
    pass


def request_json(url, data=None, token=None):
    """GET url (POST if data is given) and return the decoded JSON response."""
    req = urllib.request.Request(url, data=data)
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as err:
        raise GoogleError(describe(err)) from None


def describe(err):
    """Google's error message from the body of an HTTPError."""
    try:
        body = json.load(err)
    except ValueError:
        return f"HTTP {err.code}"
    error = body.get("error")
    if isinstance(error, dict):  # API error
        return error.get("message", f"HTTP {err.code}")
    if error:  # OAuth error
        return f"{error}: {body.get('error_description', '')}".rstrip(": ")
    return f"HTTP {err.code}"


def iso_date(text):
    try:
        return dt.date.fromisoformat(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"expected YYYY-MM-DD, got {text!r}") from None


def parse_args():
    parser = argparse.ArgumentParser(description="Fetch YouTube Analytics for your channel.")
    parser.add_argument("--days", type=int, default=28, help="number of days, ending yesterday (default 28)")
    parser.add_argument("--start", type=iso_date, help="first day, YYYY-MM-DD")
    parser.add_argument("--end", type=iso_date, help="last day, YYYY-MM-DD (default yesterday)")
    parser.add_argument("--currency", default="USD", help="currency for revenue, e.g. EUR (default USD)")
    parser.add_argument("--out", help="folder for the CSV files (default output/<start>_<end>)")
    args = parser.parse_args()
    if args.days < 1:
        parser.error("--days must be at least 1")
    args.end = args.end or dt.date.today() - dt.timedelta(days=1)
    args.start = args.start or args.end - dt.timedelta(days=args.days - 1)
    if args.start > args.end:
        parser.error("--start must not be after --end")
    return args


def credentials():
    names = ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"]
    values = [os.environ.get(name, "").strip() for name in names]
    missing = [name for name, value in zip(names, values) if not value]
    if missing:
        sys.exit("Missing environment variables: " + ", ".join(missing) +
                 "\nSee README.md (Setup) for how to get them.")
    return values


def access_token(client_id, client_secret, refresh_token):
    """Trade the refresh token for an access token; also return the granted scopes."""
    try:
        tokens = request_json(TOKEN_URL, data=urllib.parse.urlencode({
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        }).encode())
    except GoogleError as err:
        if "invalid_grant" in str(err):
            sys.exit(f"Google rejected the refresh token ({err}).\n"
                     "Run get_refresh_token.py again. If this happens every 7 days, the app is still in "
                     "Testing mode: publish it (README, step 1).")
        sys.exit(f"Couldn't sign in to Google: {err}")
    return tokens["access_token"], tokens.get("scope", "").split()


def get_channel(token):
    items = request_json(f"{DATA_API}/channels?part=snippet,statistics&mine=true", token=token).get("items", [])
    if not items:
        sys.exit("This Google account has no YouTube channel. Run get_refresh_token.py again and pick "
                 "the account (or brand account) that owns your channel.")
    return items[0]


def run_report(token, start, end, query):
    params = {"ids": "channel==MINE", "startDate": start.isoformat(), "endDate": end.isoformat(), **query}
    data = request_json(f"{REPORTS_URL}?{urllib.parse.urlencode(params)}", token=token)
    return {"headers": [column["name"] for column in data.get("columnHeaders", [])],
            "rows": data.get("rows", [])}


def add_titles(token, report):
    """Insert a title column after the video ID column."""
    ids = [row[0] for row in report["rows"]]
    titles = {}
    for i in range(0, len(ids), 50):  # the videos endpoint takes at most 50 IDs
        query = urllib.parse.urlencode({"part": "snippet", "id": ",".join(ids[i:i + 50])})
        for item in request_json(f"{DATA_API}/videos?{query}", token=token).get("items", []):
            titles[item["id"]] = item["snippet"]["title"]
    report["headers"].insert(1, "title")
    for row in report["rows"]:
        row.insert(1, titles.get(row[0], ""))


def save_csvs(out_dir, reports):
    os.makedirs(out_dir, exist_ok=True)
    for name, report in reports.items():
        if "rows" in report:
            with open(os.path.join(out_dir, f"{name}.csv"), "w", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                writer.writerow(report["headers"])
                writer.writerows(report["rows"])


def records(report):
    """Rows of a report as dicts keyed by column name ([] if the report failed)."""
    return [dict(zip(report["headers"], row)) for row in report.get("rows", [])]


def num(value):
    return f"{int(round(float(value))):,}"


def hours(minutes):
    return f"{float(minutes) / 60:,.1f} h"


def duration(seconds):
    seconds = int(round(float(seconds)))
    return f"{seconds // 60}:{seconds % 60:02d}"


def section(title, report):
    print(f"\n{title}")
    if "error" in report:
        print(f"  (couldn't load: {report['error']})")
    elif not report["rows"]:
        print("  (no data for this period)")


def share_table(title, report, label, limit=10):
    section(title, report)
    rows = records(report)
    total = sum(row["views"] for row in rows) or 1
    for row in rows[:limit]:
        name = label(row[report["headers"][0]])
        print(f"  {name:<26}{num(row['views']):>10} views {100 * row['views'] / total:6.1f}%")


def age_label(group):
    group = group[len("age"):]  # "age18-24" -> "18-24", "age65-" -> "65+"
    return group[:-1] + "+" if group.endswith("-") else group


def print_summary(channel, args, reports):
    stats = channel.get("statistics", {})
    subscribers = "hidden" if stats.get("hiddenSubscriberCount") else num(stats.get("subscriberCount", 0))
    print(f"Channel: {channel['snippet']['title']} ({channel['id']})")
    print(f"All time: {subscribers} subscribers, {num(stats.get('viewCount', 0))} views, "
          f"{num(stats.get('videoCount', 0))} videos")

    totals = (records(reports["totals"]) or [{}])[0]
    gained, lost = totals.get("subscribersGained", 0), totals.get("subscribersLost", 0)
    print(f"\n{args.start} to {args.end} ({(args.end - args.start).days + 1} days)")
    print(f"  Views              {num(totals.get('views', 0))}")
    print(f"  Watch time         {hours(totals.get('estimatedMinutesWatched', 0))}")
    print(f"  Avg view duration  {duration(totals.get('averageViewDuration', 0))}")
    print(f"  Subscribers        +{num(gained)} / -{num(lost)} (net {int(gained) - int(lost):+,})")
    print(f"  Likes              {num(totals.get('likes', 0))}")
    print(f"  Comments           {num(totals.get('comments', 0))}")
    print(f"  Shares             {num(totals.get('shares', 0))}")
    daily = records(reports["daily"])
    if daily:
        best = max(daily, key=lambda row: row["views"])
        print(f"  Best day           {best['day']} ({num(best['views'])} views)")

    section("Top videos by views", reports["top_videos"])
    for i, video in enumerate(records(reports["top_videos"])[:10], 1):
        print(f"  {i:>2}. {num(video['views']):>9} views {hours(video['estimatedMinutesWatched']):>10}"
              f"  avg {duration(video['averageViewDuration'])} ({video['averageViewPercentage']:.0f}%)"
              f"  {video.get('title') or video['video']}")

    share_table("Traffic sources", reports["traffic_sources"], lambda key: TRAFFIC_SOURCE_NAMES.get(key, key))
    share_table("Top countries", reports["countries"], str)
    share_table("Devices", reports["devices"], lambda key: key.replace("_", " ").capitalize())

    section("Audience (% of signed-in viewers)", reports["demographics"])
    by_gender, by_age = {}, {}
    for row in records(reports["demographics"]):
        by_gender[row["gender"]] = by_gender.get(row["gender"], 0) + row["viewerPercentage"]
        by_age[row["ageGroup"]] = by_age.get(row["ageGroup"], 0) + row["viewerPercentage"]
    if by_gender:
        print("  Gender  " + ", ".join(f"{gender} {share:.1f}%" for gender, share
                                       in sorted(by_gender.items(), key=lambda item: -item[1])))
        print("  Age     " + ", ".join(f"{age_label(age)} {share:.1f}%" for age, share in sorted(by_age.items())))

    if "revenue_daily" in reports:
        section(f"Estimated revenue ({args.currency})", reports["revenue_daily"])
        revenue = records(reports["revenue_daily"])
        if revenue:
            total = sum(row["estimatedRevenue"] for row in revenue)
            ads = sum(row["estimatedAdRevenue"] for row in revenue)
            premium = sum(row["estimatedRedPartnerRevenue"] for row in revenue)
            print(f"  Total {total:,.2f} (ads {ads:,.2f}, YouTube Premium {premium:,.2f})")


def main():
    args = parse_args()
    token, scopes = access_token(*credentials())
    try:
        channel = get_channel(token)
    except GoogleError as err:
        sys.exit(f"YouTube Data API error: {err}")

    queries = dict(REPORTS)
    if REVENUE_SCOPE in scopes:
        queries["revenue_daily"] = dict(REVENUE_REPORT, currency=args.currency)
    reports = {}
    for name, query in queries.items():
        try:
            reports[name] = run_report(token, args.start, args.end, query)
        except GoogleError as err:
            if name == "totals":  # the first query; if it fails, the rest will too
                sys.exit(f"YouTube Analytics API error: {err}")
            reports[name] = {"error": str(err)}

    if reports["top_videos"].get("rows"):
        try:
            add_titles(token, reports["top_videos"])
        except GoogleError as err:
            print(f"(Couldn't load video titles: {err})", file=sys.stderr)

    out_dir = args.out or os.path.join(os.path.dirname(os.path.abspath(__file__)), "output",
                                       f"{args.start}_{args.end}")
    save_csvs(out_dir, reports)
    print_summary(channel, args, reports)
    print(f"\nCSV files: {out_dir}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit("\nCancelled.")
    except urllib.error.URLError as err:
        hint = ""
        if isinstance(err.reason, ssl.SSLCertVerificationError):
            hint = ("\nOn macOS, run 'Install Certificates.command' from your Python folder "
                    "in Applications, then try again.")
        sys.exit(f"Network error: {err.reason}{hint}")

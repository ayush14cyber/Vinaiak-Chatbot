# Test corpus

Real scraped pages, used by `tests/real_corpus.rs` and `examples/live`.

| Folder | Source | Pages |
|---|---|---|
| `bitmesra/` | `s3://vinaiak-storage--aps1-az1--x-s3/vinaiakStorage/clients/1/school_data/creates/` | 9 |
| `iitism/` | `s3://vinaiak-storage--aps1-az1--x-s3/vinaiakStorage/clients/3/school_data/creates/` | 12 |

File names are the original object keys. Content is verbatim — the markdown,
the link soup, the inconsistent heading levels and the one page that spells it
"Academic Calender" are all left as scraped, because handling real input is the
point.

## Why these 21

They were chosen to cover the cases the engine has to get right, not for
tidiness:

- `bitmesra/3712.txt` — 43 KB, **two headings**, almost entirely a fee table.
  Nothing to split on by topic; splitting it by size without keeping one shared
  context would produce misleading fragments. This is the case
  `Cohesion::Inseparable` exists for.
- `iitism/100.txt` — 75 KB, **397 headings**, 403 faculty entries. One document
  that would otherwise monopolize every generic query, and the reason
  `per_doc_quota` exists. Also why `max_groups` has to be raised from its default
  for this corpus.
- `iitism/77.txt` — 58 sections of academic-calendar tables and date lists.
- `iitism/35.txt` — 59 bytes, no heading, one sentence.
- `bitmesra/3675.txt`, `3704.txt`, `3709.txt`-style notices — a few hundred bytes,
  mostly a link.
- `iitism/36.txt`, `37.txt`, `38.txt` — pages sharing the same navigation and logo
  boilerplate, so cross-document duplicate suppression has something to find.
- `bitmesra/3702.txt`, `3703.txt`, `3705.txt`, `3708.txt`, `3711.txt`,
  `iitism/82.txt`, `86.txt`, `95.txt`, `99.txt` — the pages the golden queries in
  `real_corpus.rs` expect: admission procedure, calendar, refunds, contacts,
  application fees, seat distribution.

## Refreshing it

```sh
aws s3 cp "s3://vinaiak-storage--aps1-az1--x-s3/vinaiakStorage/clients/1/school_data/creates/" ./bitmesra/ --recursive --region ap-south-1
```

If you re-sync, re-check the golden query expectations in
`tests/real_corpus.rs`: they name the pages that genuinely answer each question,
verified against the text at the time of writing.

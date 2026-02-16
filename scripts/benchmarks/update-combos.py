#!/usr/bin/env python3
"""
Fetches 2-card combos from Commander Spellbook API and creates public/combos.json.
Run periodically: python3 scripts/update-combos.py
"""
import json, urllib.request, time, os

BASE_URL = 'https://backend.commanderspellbook.com/variants/?limit=100&q=card%3C4&format=json'
OUTPUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'combos.json')

def fetch_combos():
    all_combos = []
    url = BASE_URL
    page = 0

    while url and page < 500:
        try:
            req = urllib.request.Request(url, headers={'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read())
            
            for combo in data.get('results', []):
                if combo.get('status') != 'OK':
                    continue
                cards = sorted([u['card']['name'] for u in combo.get('uses', [])])
                if len(cards) != 2:
                    continue
                feats = [p['feature']['name'] for p in combo.get('produces', [])]
                cid = combo.get('id', '')
                all_combos.append({'c': cards, 'r': feats, 'id': cid})
            
            url = data.get('next')
            page += 1
            if page % 20 == 0:
                print(f'  Page {page}: {len(all_combos)} combos...')
            time.sleep(0.05)
        except Exception as e:
            print(f'Error on page {page}: {e}')
            break

    # Deduplicate
    seen = set()
    unique = []
    for c in all_combos:
        key = tuple(c['c'])
        if key not in seen:
            seen.add(key)
            unique.append(c)

    return unique

if __name__ == '__main__':
    print('Fetching 2-card combos from Commander Spellbook...')
    combos = fetch_combos()
    print(f'\nTotal: {len(combos)} unique 2-card combos')
    
    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    with open(OUTPUT, 'w') as f:
        json.dump(combos, f, separators=(',', ':'))
    
    size = os.path.getsize(OUTPUT)
    print(f'Saved to {OUTPUT} ({size/1024:.0f} KB)')
    print('Done! Run `npm run build` to include in dist.')

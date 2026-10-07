#!/usr/bin/env python3
"""Install the local Quickread Chrome extension into the default Chrome profile."""

import datetime
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
from collections import OrderedDict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
EXTENSION_PATH = str((REPO_ROOT / 'extension').resolve())
CHROME_ROOT = Path.home() / 'Library/Application Support/Google/Chrome'
SEED = b'\xe7H\xf36\xd8^\xa5\xf9\xdc\xdf%\xd8\xf3G\xa6[L\xdffv\x00\xf0-\xf6rJ*\xf1\x8a!-&\xb7\x88\xa2P\x86\x91\x0c\xf3\xa9\x03\x13ihq\xf3\xdc\x05\x8270\xc9\x1d\xf8\xba\\O\xd9\xc8\x84\xb5\x05\xa8'


def encode_to_install_time(date):
    base_date = datetime.datetime(1970, 1, 1)
    difference_in_seconds = (date - base_date).total_seconds()
    return int(difference_in_seconds * 1000000) + 11644473600000000


def get_extension_id(path):
    digest = hashlib.sha256(path.encode('utf-8')).hexdigest()
    return ''.join(chr(int(i, 16) + ord('a')) for i in digest[:32])


def get_hardware_uuid():
    output = subprocess.check_output(['system_profiler', 'SPHardwareDataType'], text=True)
    match = re.search(r'Hardware UUID:\s*(.+)', output)
    if not match:
        raise RuntimeError('Could not read hardware UUID')
    return match.group(1).strip()


def remove_empty(value):
    if isinstance(value, OrderedDict):
        for key in list(value.keys()):
            item = value[key]
            remove_empty(item)
            if item in ({}, [], '', None):
                del value[key]
    elif isinstance(value, dict):
        for key in list(value.keys()):
            item = value[key]
            remove_empty(item)
            if item in ({}, [], '', None):
                del value[key]
    elif isinstance(value, list):
        for item in value:
            remove_empty(item)
        value[:] = [item for item in value if item not in ({}, [], '', None)]


def calculate_hmac(value, path, sid):
    if isinstance(value, (dict, OrderedDict)):
        remove_empty(value)
    message = sid + path + json.dumps(value, separators=(',', ':'), ensure_ascii=False).replace('<', '\\u003C').replace('\\u2122', '™')
    return hmac.new(SEED, message.encode('utf-8'), hashlib.sha256).hexdigest().upper()


def calculate_dev_mac(sid, pref_path, pref_value):
    serialized = json.dumps(pref_value, separators=(',', ':'), sort_keys=True)
    return hmac.new(SEED, (sid + pref_path + serialized).encode('utf-8'), hashlib.sha256).hexdigest()


def calc_supermac(filepath, sid):
    with open(filepath, encoding='utf-8') as handle:
        data = json.load(handle, object_pairs_hook=OrderedDict)
    temp = OrderedDict(sorted(data.items()))
    super_msg = sid + json.dumps(temp['protection']['macs']).replace(' ', '')
    return hmac.new(SEED, super_msg.encode('utf-8'), hashlib.sha256).hexdigest().upper()


def build_extension_entry(manifest, install_time):
    return OrderedDict([
        ('account_extension_type', 0),
        ('active_permissions', OrderedDict([
            ('api', ['contextMenus', 'activeTab', 'storage']),
            ('explicit_host', ['<all_urls>']),
            ('manifest_permissions', []),
            ('scriptable_host', []),
        ])),
        ('commands', OrderedDict([
            ('_execute_action', OrderedDict([('was_assigned', True)])),
        ])),
        ('content_settings', []),
        ('creation_flags', 38),
        ('first_install_time', str(install_time)),
        ('from_webstore', False),
        ('granted_permissions', OrderedDict([
            ('api', ['contextMenus', 'activeTab', 'storage']),
            ('explicit_host', ['<all_urls>']),
            ('manifest_permissions', []),
            ('scriptable_host', []),
        ])),
        ('incognito_content_settings', []),
        ('incognito_preferences', OrderedDict()),
        ('last_update_time', str(install_time)),
        ('location', 4),
        ('manifest', manifest),
        ('newAllowFileAccess', True),
        ('path', EXTENSION_PATH),
        ('preferences', OrderedDict()),
        ('regular_only_preferences', OrderedDict()),
        ('service_worker_registration_info', OrderedDict([('version', manifest['version'])])),
        ('state', 1),
        ('was_installed_by_default', False),
        ('was_installed_by_oem', False),
        ('withholding_permissions', False),
    ])


def ensure_developer_mode(data, sid):
    data['extensions'].setdefault('settings', OrderedDict())
    data['extensions'].setdefault('ui', OrderedDict())
    data['extensions']['ui']['developer_mode'] = True

    data['protection'].setdefault('macs', OrderedDict())
    data['protection']['macs'].setdefault('extensions', OrderedDict())
    data['protection']['macs']['extensions'].setdefault('settings', OrderedDict())
    data['protection']['macs']['extensions'].setdefault('ui', OrderedDict())
    data['protection']['macs']['extensions']['ui']['developer_mode'] = calculate_dev_mac(
        sid, 'extensions.ui.developer_mode', True
    )

    if 'account_values' in data:
        data['account_values'].setdefault('extensions', OrderedDict())
        data['account_values']['extensions'].setdefault('ui', OrderedDict())
        data['account_values']['extensions']['ui']['developer_mode'] = True
        data['protection']['macs'].setdefault('account_values', OrderedDict())
        data['protection']['macs']['account_values'].setdefault('extensions', OrderedDict())
        data['protection']['macs']['account_values']['extensions'].setdefault('ui', OrderedDict())
        data['protection']['macs']['account_values']['extensions']['ui']['developer_mode'] = calculate_dev_mac(
            sid, 'account_values.extensions.ui.developer_mode', True
        ).upper()


def remove_encrypted_hash_keys(obj):
    if isinstance(obj, dict):
        for key in list(obj.keys()):
            if '_encrypted_hash' in key:
                del obj[key]
            else:
                remove_encrypted_hash_keys(obj[key])
    elif isinstance(obj, list):
        for item in obj:
            remove_encrypted_hash_keys(item)


def main():
    profile = sys.argv[1] if len(sys.argv) > 1 else 'Default'
    secure_prefs = CHROME_ROOT / profile / 'Secure Preferences'
    if not secure_prefs.exists():
        raise SystemExit(f'Chrome profile not found: {secure_prefs}')

    manifest_path = Path(EXTENSION_PATH) / 'manifest.json'
    with open(manifest_path, encoding='utf-8') as handle:
        manifest = json.load(handle, object_pairs_hook=OrderedDict)

    sid = get_hardware_uuid()
    ext_id = get_extension_id(EXTENSION_PATH)
    install_time = encode_to_install_time(datetime.datetime.now())
    entry = build_extension_entry(manifest, install_time)

    with open(secure_prefs, encoding='utf-8') as handle:
        data = json.load(handle, object_pairs_hook=OrderedDict)

    ensure_developer_mode(data, sid)
    data['extensions']['settings'][ext_id] = entry
    data['protection']['macs']['extensions']['settings'][ext_id] = calculate_hmac(
        entry, f'extensions.settings.{ext_id}', sid
    )

    serialized = json.dumps(data)
    with open(secure_prefs, 'w', encoding='utf-8') as handle:
        handle.write(serialized)

    data = json.loads(serialized, object_pairs_hook=OrderedDict)
    data['protection']['super_mac'] = calc_supermac(secure_prefs, sid)
    remove_encrypted_hash_keys(data)

    with open(secure_prefs, 'w', encoding='utf-8') as handle:
        json.dump(data, handle)

    print(f'Installed Quickread extension {ext_id} into {profile} from {EXTENSION_PATH}')


if __name__ == '__main__':
    main()

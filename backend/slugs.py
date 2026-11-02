"""The slug character class and the refused-character report Papyrus names.

Restated from ``kiro_crew.slugs`` (the two pieces this app uses), so a refused
project name is explained the same way the gateway explains its own slugs.
"""

from __future__ import annotations

import unicodedata

SLUG_CHARS = frozenset("abcdefghijklmnopqrstuvwxyz0123456789._-")


def refused_slug_char(typed: str) -> str:
    """Return the first character of *typed* a slug name cannot hold, as typed.

    Reporting only, never validation: the caller's own pattern decides whether
    the name is accepted. *typed* is the name BEFORE normalization (trim,
    whitespace to ``-``, lowercase), and each character is judged by what that
    normalizer makes of it, so the answer is a character the user actually
    typed. ``""`` means no single character is to blame (the name failed on its
    length or on where a character sits).

    NFC first, so a decomposed ``u`` + U+0308 is reported as ``ü``. A control,
    format or combining character comes back as its code point (``U+202E``), so
    the message that names it can be neither hidden nor reordered by it.
    """
    for char in unicodedata.normalize("NFC", typed):
        if char.isspace() or all(c in SLUG_CHARS for c in char.lower()):
            continue
        if char.isprintable() and unicodedata.category(char)[0] != "M":
            return char
        return f"U+{ord(char):04X}"
    return ""

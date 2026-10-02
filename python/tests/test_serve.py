"""
The door to the reader: who is let in.

`holds_key` is the whole of the reader's authentication, so it is worth having
tests that fail loudly. The cases below are the ones a mistake would turn into
an open server: a near-miss key, an empty key, a key named something else in
the cookie jar.

    .venv/bin/python -m pytest python/tests/test_serve.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from serve import KEY_COOKIE, holds_key  # noqa: E402

KEY = "s3cret-key-value"


class TestNoKeyAsked:
    def test_without_a_token_every_caller_is_let_in(self):
        # How the reader runs on localhost: the only callers are on this
        # machine, and asking them for a key would be ceremony.
        assert holds_key(None) is True
        assert holds_key(None, authorization="Bearer anything") is True

    def test_an_empty_token_asks_for_no_key_rather_than_an_empty_one(self):
        # `main` folds an empty --token to None, and this agrees with it. The
        # other reading — a key that is the empty string — would be a server
        # that looks protected and admits a caller presenting nothing.
        assert holds_key("") is True
        assert holds_key("", cookie=f"{KEY_COOKIE}=") is True


class TestHeader:
    def test_the_key_as_a_bearer_token(self):
        assert holds_key(KEY, authorization=f"Bearer {KEY}") is True

    def test_surrounding_space_is_not_part_of_the_key(self):
        assert holds_key(KEY, authorization=f"  Bearer   {KEY}  ") is True

    def test_another_scheme_does_not_count(self):
        assert holds_key(KEY, authorization=f"Basic {KEY}") is False

    def test_the_key_alone_is_not_a_bearer_token(self):
        assert holds_key(KEY, authorization=KEY) is False


class TestCookie:
    def test_the_key_in_its_own_cookie(self):
        assert holds_key(KEY, cookie=f"{KEY_COOKIE}={KEY}") is True

    def test_found_among_other_cookies(self):
        assert holds_key(KEY, cookie=f"theme=dark; {KEY_COOKIE}={KEY}; seen=1") is True

    def test_a_cookie_of_another_name_does_not_count(self):
        # Any page can set a cookie on its own origin; only this name is the key.
        assert holds_key(KEY, cookie=f"session={KEY}") is False

    def test_an_empty_cookie_is_not_a_key(self):
        assert holds_key(KEY, cookie=f"{KEY_COOKIE}=") is False


class TestQuery:
    def test_the_key_in_the_url(self):
        assert holds_key(KEY, query=f"key={KEY}") is True

    def test_beside_the_other_parameters(self):
        assert holds_key(KEY, query=f"doc=abc&n=2&key={KEY}") is True

    def test_an_empty_key_parameter_is_not_a_key(self):
        assert holds_key(KEY, query="key=") is False


class TestRefused:
    def test_nothing_presented(self):
        assert holds_key(KEY) is False

    def test_a_wrong_key(self):
        assert holds_key(KEY, authorization="Bearer wrong-key-value") is False

    def test_a_key_that_is_right_but_for_the_last_character(self):
        assert holds_key(KEY, authorization=f"Bearer {KEY[:-1]}x") is False

    def test_a_key_that_is_only_the_start_of_the_real_one(self):
        # The comparison is of the whole value, not a prefix.
        assert holds_key(KEY, authorization=f"Bearer {KEY[:8]}") is False

    def test_a_key_with_the_real_one_inside_it(self):
        assert holds_key(KEY, authorization=f"Bearer x{KEY}") is False

    def test_a_wrong_key_in_one_place_is_not_saved_by_an_empty_other(self):
        assert holds_key(KEY, authorization="Bearer nope", cookie="", query="") is False

    def test_the_right_key_in_any_one_place_is_enough(self):
        assert holds_key(KEY, authorization="Bearer nope", cookie=f"{KEY_COOKIE}={KEY}") is True
        assert holds_key(KEY, cookie="reader_key=nope", query=f"key={KEY}") is True

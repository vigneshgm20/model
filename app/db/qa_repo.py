# app/db/qa_repo.py
from .connection import get_db
from datetime import datetime


def save_message(session_id, role, content):
    """Save a Q/A message to database"""
    db = get_db()
    cur = db.cursor()

    try:
        cur.execute("""
            INSERT INTO qa_messages (session_id, role, content)
            VALUES (?, ?, ?)
        """, (session_id, role, content))

        db.commit()
        print(f"💾 Saved message: session={session_id}, role={role}")
    except Exception as e:
        db.rollback()
        raise e
    finally:
        cur.close()
        db.close()


def get_recent_history(session_id, limit=10):
    """
    Get recent Q/A history for a session, in chronological order.

    Uses a subquery so that:
      - The INNER query picks the most recent N rows (DESC).
      - The OUTER query re-sorts them ASC so the caller receives them
        in the order they happened.

    This avoids the same-second ambiguity that can occur when a question
    and answer are saved back-to-back: ORDER BY created_at DESC, id DESC
    inside the subquery still disambiguates correctly, and the outer
    ORDER BY created_at ASC, id ASC restores chronological order.
    """
    db = get_db()
    cur = db.cursor()

    try:
        cur.execute("""
            SELECT role, content, created_at
            FROM (
                SELECT id, role, content, created_at
                FROM qa_messages
                WHERE session_id = ?
                ORDER BY created_at DESC, id DESC
                LIMIT ?
            )
            ORDER BY created_at ASC, id ASC
        """, (session_id, limit))

        rows = cur.fetchall()
        result = []

        for row in rows:
            row_dict = dict(row)
            if row_dict.get('created_at'):
                if isinstance(row_dict['created_at'], datetime):
                    row_dict['created_at'] = row_dict['created_at'].isoformat()
            result.append(row_dict)

        return result
    finally:
        cur.close()
        db.close()
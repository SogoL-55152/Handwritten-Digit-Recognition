from celery_app import celery_app
from services.trainer import train_task


@celery_app.task(name="train_model")
def train_model_task(task_id: str, params: dict):
    return train_task(task_id, params)

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

# 日記エントリを保持するシングルテーブル。
#
# ベーステーブルのキー設計:
#   pk = "ENTRY#<年>"      年でパーティションを切る。1パーティション最大366アイテム。
#   sk = "<YYYY-MM-DD>"    年内で日付順に並ぶ。
#
# これにより、特定日の取得は Query ですらなく GetItem で済み、
# 年別・月別の一覧もベーステーブルだけで完結する。
resource "aws_dynamodb_table" "diary" {
  name         = "apkas-diary-${var.environment}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  attribute {
    name = "gsi1pk"
    type = "S"
  }

  attribute {
    name = "gsi1sk"
    type = "S"
  }

  # 公開エントリを日付順に引くための索引。
  #
  # gsi1pk は定数 "ENTRY" を取る。一般には書き込みが1パーティションに集中する
  # 反パターンだが、書き込みが1日1件程度の個人日記では上限（1000 WCU）と桁が
  # 3つ以上離れており成立しない。
  #
  # 下書きは gsi1pk / gsi1sk 属性そのものを書かないため、この索引に載らない
  # （sparse index）。公開サイトの生成は本索引を読むだけで公開分のみを得るので、
  # 取得側のフィルタのバグによる下書き漏洩が起こりえない。
  global_secondary_index {
    name            = "gsi1"
    projection_type = "ALL"

    key_schema {
      attribute_name = "gsi1pk"
      key_type       = "HASH"
    }

    key_schema {
      attribute_name = "gsi1sk"
      key_type       = "RANGE"
    }
  }

  # 日記は再取得が不可能なデータであり、誤操作からの復旧手段は必須。
  point_in_time_recovery {
    enabled = true
  }

  deletion_protection_enabled = var.deletion_protection

  tags = merge(var.tags, {
    Name = "apkas-diary-${var.environment}"
  })
}

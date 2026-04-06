#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VCP 热点自动归档工具 演示版
功能：搜索指定关键词热点，自动生成Markdown归档报告
"""
import requests
import json
from datetime import datetime
import os

# -------------------------- 配置项 --------------------------
# 请填写你的Tavily API密钥，可在 https://tavily.com/ 免费申请
TAVILY_API_KEY = "your_api_key_here"
# 归档报告保存目录
SAVE_DIR = "./hot_archive"
# 搜索关键词
SEARCH_KEYWORD = "2026年AI最新进展"
# 搜索结果数量
SEARCH_MAX_RESULTS = 10
# -----------------------------------------------------------

def tavily_search(keyword: str, max_results: int = 10) -> dict:
    """调用Tavily搜索引擎获取热点信息"""
    url = "https://api.tavily.com/search"
    payload = {
        "api_key": TAVILY_API_KEY,
        "query": keyword,
        "search_depth": "basic",
        "max_results": max_results,
        "include_answer": True,
        "include_images": False,
        "include_raw_content": False
    }
    
    try:
        response = requests.post(url, json=payload, timeout=30)
        response.raise_for_status()
        return response.json()
    except Exception as e:
        print(f"搜索请求失败: {str(e)}")
        return {}

def generate_markdown_report(search_result: dict, keyword: str) -> str:
    """根据搜索结果生成Markdown格式报告"""
    if not search_result:
        return "# 热点归档报告\n\n搜索失败，无数据返回"
    
    current_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    answer = search_result.get("answer", "无总结内容")
    results = search_result.get("results", [])
    
    # 构建Markdown内容
    markdown = f"""# 🔍 热点归档报告：{keyword}
生成时间：{current_time}

## 📊 核心总结
{answer}

## 📋 详细来源
"""
    for idx, item in enumerate(results, 1):
        title = item.get("title", "无标题")
        url = item.get("url", "无链接")
        content = item.get("content", "无内容")
        markdown += f"""### {idx}. [{title}]({url})
{content}

"""
    markdown += "---\n本报告由VCP热点自动归档工具自动生成"
    return markdown

def save_report(content: str, keyword: str) -> str:
    """保存报告到本地文件"""
    # 确保目录存在
    if not os.path.exists(SAVE_DIR):
        os.makedirs(SAVE_DIR)
    
    # 生成文件名
    date_str = datetime.now().strftime("%Y%m%d_%H%M%S")
    file_name = f"{date_str}_{keyword.replace(' ', '_')}.md"
    file_path = os.path.join(SAVE_DIR, file_name)
    
    try:
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"报告已保存到: {file_path}")
        return file_path
    except Exception as e:
        print(f"保存报告失败: {str(e)}")
        return ""

def main():
    print(f"开始搜索热点：{SEARCH_KEYWORD}")
    # 1. 搜索热点
    search_result = tavily_search(SEARCH_KEYWORD, SEARCH_MAX_RESULTS)
    if not search_result:
        return
    
    # 2. 生成报告
    report_content = generate_markdown_report(search_result, SEARCH_KEYWORD)
    
    # 3. 保存报告
    save_path = save_report(report_content, SEARCH_KEYWORD)
    if save_path:
        print(f"归档完成！报告路径：{save_path}")

if __name__ == "__main__":
    main()